"""
Evaluate a U-Net checkpoint on the held-out test scenes and write a provenance-stamped JSON report.

READ-ONLY with respect to checkpoints: the checkpoint is only loaded (its SHA-256 is recorded before
and after). The same code path evaluates the frozen baseline and any candidate, so a comparison is
made under an IDENTICAL protocol.

Protocols reported (all threshold 0.5, all on the same scenes):
  historic       whole-scene z-score, 256 px tiles stride 256, uncovered right/bottom strips count as
                 "no oil". Replicates ml/inference/test_model.py (source of the stored baseline numbers).
  scene_overlap  whole-scene z-score, 256 px tiles, 32 px overlap, reflect-padded (FULL coverage).
  patch_overlap  per-256 px-patch z-score, 32 px overlap (the normalisation the baseline was TRAINED
                 with, ml/datasets/dataset.py normalization="patch").

Metrics: Dice, IoU, precision, recall, pixel false-positive rate (pooled = micro and macro = mean over
scenes), false-alarm scenes, calibration (ECE, Brier). Nothing is estimated: every number is computed here.

    AEGIS_DATA_ROOT="..." python ml/evaluation/run_eval.py --label baseline
    python ml/evaluation/run_eval.py --checkpoint ml/checkpoints/candidates/<run>/candidate_best.pth --label candidate_six_epoch
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sys
import time
from datetime import datetime, timezone
from typing import Dict, List, Tuple

import numpy as np

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, PROJECT_ROOT)

from ml.data_root import radar_dataset_root, data_root  # noqa: E402
from ml.evaluation.protocol import (  # noqa: E402
    confusion, evaluate_scenes, metrics_from_confusion, tile_predict,
)

FROZEN = os.path.join(PROJECT_ROOT, "ml", "checkpoints", "unet_oil_spill_best.pth")
BASELINE_JSON = os.path.join(PROJECT_ROOT, "ml", "baseline", "BASELINE_v1.json")
THRESHOLD = 0.5


def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def load_model(checkpoint: str):
    import torch
    from ml.models.unet import SAROilSpillUNet, get_device

    device = get_device()
    model = SAROilSpillUNet(in_channels=1, num_classes=1, bilinear=True)
    try:
        ck = torch.load(checkpoint, map_location="cpu", weights_only=True)
    except Exception:  # older/other pickles; the file is only read
        ck = torch.load(checkpoint, map_location="cpu", weights_only=False)
    model.load_state_dict(ck["model_state_dict"] if "model_state_dict" in ck else ck)
    model.to(device).eval()
    meta = {k: ck[k] for k in ("epoch", "val_dice", "val_iou", "val_precision", "val_recall", "seed", "candidate") if isinstance(ck, dict) and k in ck}
    return model, device, meta


def make_predictor(model, device):
    import torch

    def predict(tile: np.ndarray) -> np.ndarray:
        with torch.no_grad():
            x = torch.from_numpy(np.ascontiguousarray(tile, dtype=np.float32))[None, None].to(device)
            return torch.sigmoid(model(x))[0, 0].cpu().numpy()
    return predict


def zscore_scene(image: np.ndarray) -> np.ndarray:
    """Same as ml/inference/test_model.py normalize_image()."""
    image = image.astype(np.float32)
    valid = np.isfinite(image)
    if valid.any():
        v = image[valid]
        image = (image - v.mean()) / (v.std() + 1e-6)
    else:
        image = np.zeros_like(image)
    return np.nan_to_num(image, nan=0.0, posinf=0.0, neginf=0.0).astype(np.float32)


def historic_prediction(image: np.ndarray, predict) -> np.ndarray:
    """Replicates the stored protocol: non-overlapping full 256 tiles only; strips beyond the last full tile stay 0."""
    img = zscore_scene(image)
    h, w = img.shape
    pred = np.zeros((h, w), np.uint8)
    for y in range(0, h - 256 + 1, 256):
        for x in range(0, w - 256 + 1, 256):
            pred[y:y + 256, x:x + 256] = (predict(img[y:y + 256, x:x + 256]) > THRESHOLD).astype(np.uint8)
    return pred


def historic_metrics(pred: np.ndarray, gt: np.ndarray) -> Dict[str, float]:
    """The exact formulas of test_model.calculate_metrics (eps 1e-8) so stored numbers are comparable."""
    p, g = pred.astype(bool), gt.astype(bool)
    inter = np.logical_and(p, g).sum()
    union = np.logical_or(p, g).sum()
    return {
        "dice": float(2.0 * inter / (p.sum() + g.sum() + 1e-8)),
        "iou": float(inter / (union + 1e-8)),
        "precision": float(inter / (p.sum() + 1e-8)),
        "recall": float(inter / (g.sum() + 1e-8)),
    }


def read_scenes(root: str) -> List[Tuple[str, np.ndarray, np.ndarray]]:
    import rasterio
    out = []
    img_dir, msk_dir = os.path.join(root, "test", "images"), os.path.join(root, "test", "masks")
    for f in sorted(x for x in os.listdir(img_dir) if x.lower().endswith((".tif", ".tiff"))):
        with rasterio.open(os.path.join(img_dir, f)) as s:
            image = s.read(1).astype(np.float32)
        with rasterio.open(os.path.join(msk_dir, f)) as s:
            mask = s.read(1).astype(np.float32)
        out.append((f, image, mask))
    return out


# ------------------------------------------------------------------ leakage checks
def _date_from_name(name: str):
    m = re.match(r"^(\d{4})_(\d{2})_(\d{2})", name) or re.match(r"^(\d{4})(\d{2})(\d{2})", name)
    return datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)), tzinfo=timezone.utc) if m else None


def leakage_report(root: str) -> Dict[str, object]:
    """Train/val leakage (CSV source scenes) and test-vs-train footprint/date proximity (raster bounds, same CRS)."""
    import pandas as pd
    import rasterio

    rep: Dict[str, object] = {}
    base = lambda d: set(d.paths.astype(str).str.replace("\\", "/").str.split("/").str[-1])
    tr = pd.read_csv(os.path.join(root, "train", "dataframe_train_dataset_256_90.csv"))
    va = pd.read_csv(os.path.join(root, "train", "dataframe_val_dataset_256_90.csv"))
    shared = sorted(base(tr) & base(va))
    rep["train_val"] = {
        "train_rows": int(len(tr)), "val_rows": int(len(va)),
        "train_source_scenes": len(base(tr)), "val_source_scenes": len(base(va)),
        "shared_source_scenes": shared,
        "verdict": "LEAKY: the validation CSV samples patches from the same source scenes as the training CSV "
                   "(patch-level split); validation Dice is optimistic and not an independent estimate."
                   if shared else "no shared source scenes",
    }
    names = lambda sp: sorted(x for x in os.listdir(os.path.join(root, sp, "images")) if x.lower().endswith(".tif"))
    test_names, train_names = names("test"), names("train")
    rep["train_test_shared_file_names"] = sorted(set(test_names) & set(train_names))

    def info(sp, n):
        with rasterio.open(os.path.join(root, sp, "images", n)) as s:
            return {"bounds": tuple(s.bounds), "crs": str(s.crs), "res": s.res, "transform": s.transform, "shape": (s.height, s.width)}

    tr_info = {n: info("train", n) for n in train_names}
    proximity = []
    for tn in test_names:
        ti = info("test", tn)
        l, b, r, t = ti["bounds"]
        entry = {"test_scene": tn, "test_date": (_date_from_name(tn) or "").isoformat() if _date_from_name(tn) else None, "train_scenes_with_overlapping_footprint": []}
        with rasterio.open(os.path.join(root, "test", "masks", tn)) as m:
            tmask = m.read(1) > 0.5
        rows, cols = np.nonzero(tmask)
        if rows.size > 200_000:
            sel = np.random.default_rng(0).choice(rows.size, 200_000, replace=False)
            rows, cols = rows[sel], cols[sel]
        xs, ys = rasterio.transform.xy(ti["transform"], rows, cols, offset="center")
        xs, ys = np.asarray(xs), np.asarray(ys)
        for rn, ri in tr_info.items():
            L, B, R_, T = ri["bounds"]
            ix = max(0.0, min(r, R_) - max(l, L)); iy = max(0.0, min(t, T) - max(b, B))
            if ix * iy <= 0:
                continue
            frac_test_area = ix * iy / ((r - l) * (t - b))
            d_test, d_train = _date_from_name(tn), _date_from_name(rn)
            days = abs((d_test - d_train).days) if d_test and d_train else None
            # do labelled test-slick pixels fall inside the train scene footprint, and onto train-labelled slick pixels?
            inside = (xs >= L) & (xs <= R_) & (ys >= B) & (ys <= T)
            onto = 0
            if inside.any():
                with rasterio.open(os.path.join(root, "train", "masks", rn)) as m2:
                    rr, cc = rasterio.transform.rowcol(m2.transform, xs[inside], ys[inside])
                    rr, cc = np.asarray(rr), np.asarray(cc)
                    ok = (rr >= 0) & (rr < m2.height) & (cc >= 0) & (cc < m2.width)
                    trmask = m2.read(1) > 0.5
                    onto = int(trmask[rr[ok], cc[ok]].sum())
            entry["train_scenes_with_overlapping_footprint"].append({
                "train_scene": rn, "days_apart": days, "overlap_fraction_of_test_footprint": round(frac_test_area, 4),
                "test_slick_pixels_inside_train_footprint": int(inside.sum()), "of_which_on_train_labelled_slick": onto,
                "sampled_test_slick_pixels": int(rows.size)})
        proximity.append(entry)
    rep["test_vs_train_footprints"] = proximity
    flagged = [e["test_scene"] for e in proximity if any(x["overlap_fraction_of_test_footprint"] > 0 for x in e["train_scenes_with_overlapping_footprint"])]
    rep["test_scenes_whose_footprint_overlaps_a_train_scene"] = flagged
    return rep


# ------------------------------------------------------------------ main
def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", default=FROZEN)
    ap.add_argument("--label", default="baseline")
    ap.add_argument("--dataset-root", default=None)
    ap.add_argument("--out", default=None)
    ap.add_argument("--skip-leakage", action="store_true")
    a = ap.parse_args(argv)

    root = a.dataset_root or str(radar_dataset_root())
    ck = os.path.abspath(a.checkpoint)
    sha_before = sha256(ck)
    frozen_sha_before = sha256(FROZEN)
    t0 = time.time()
    import torch

    model, device, ck_meta = load_model(ck)
    predict = make_predictor(model, device)
    scenes = read_scenes(root)
    print(f"[eval] {len(scenes)} test scenes | device {device} | checkpoint sha256 {sha_before[:16]}", flush=True)

    report: Dict[str, object] = {
        "schema": "aegis.checkpoint_evaluation.v1",
        "label": a.label,
        "created_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "checkpoint": {"path": os.path.relpath(ck, PROJECT_ROOT) if ck.startswith(PROJECT_ROOT) else ck, "sha256": sha_before, "size_bytes": os.path.getsize(ck), "metadata_in_file": ck_meta},
        "frozen_baseline_sha256_at_start": frozen_sha_before,
        "environment": {"device": str(device), "torch": torch.__version__, "numpy": np.__version__},
        "dataset": {"root": os.path.basename(os.path.dirname(os.path.dirname(os.path.dirname(root)))) if data_root() else root,
                    "note": "root recorded without the user's home path", "split": "test", "scene_ids": [s[0] for s in scenes],
                    "n_scenes": len(scenes), "crs": "EPSG:32616", "pixel_size_m": 10.0},
        "threshold": THRESHOLD,
        "ground_truth": "REFERENCE_LABEL masks of the labelled dataset (Zenodo 10.5281/zenodo.4672426); evaluation only",
    }

    # 1) historic protocol (comparable to stored numbers)
    hist = []
    pooled = {"tp": 0, "fp": 0, "fn": 0, "tn": 0}
    for name, image, mask in scenes:
        pred = historic_prediction(image, predict)
        gt = mask > 0.5
        c = confusion(pred.astype(bool), gt)
        for k in pooled:
            pooled[k] += c[k]
        hist.append({"scene": name, **c, **historic_metrics(pred, gt), "pixel_false_positive_rate": metrics_from_confusion(c)["pixel_false_positive_rate"]})
        print(f"[historic] {name}: dice {hist[-1]['dice']:.4f}", flush=True)
    macro = {k: float(np.mean([h[k] for h in hist])) for k in ("dice", "iou", "precision", "recall", "pixel_false_positive_rate")}
    report["historic_protocol"] = {
        "description": "whole-scene z-score, 256 px tiles stride 256, remainder strips scored as 'no oil' (replicates ml/inference/test_model.py)",
        "macro_mean": macro, "pooled": {**pooled, **metrics_from_confusion(pooled)}, "per_scene": hist,
    }

    # 2) full-coverage protocols via ml/evaluation/protocol.py
    for key, norm in (("scene_overlap_protocol", "scene"), ("patch_overlap_protocol", "patch")):
        res = evaluate_scenes(scenes, predict, threshold=THRESHOLD, normalization=norm)
        report[key] = res
        print(f"[{key}] macro dice {res['macro_mean']['dice']:.4f} | pooled dice {res['pooled']['dice']:.4f}", flush=True)

    # 3) comparison with the STORED historical metrics (both retained, never overwritten)
    try:
        stored = json.load(open(BASELINE_JSON))["recorded_test_metrics"]
        by = {x["image"]: x for x in stored["per_scene"]}
        rows = []
        for h in hist:
            s = by.get(h["scene"])
            if s:
                rows.append({"scene": h["scene"], **{f"{k}_stored": s[k] for k in ("dice", "iou", "precision", "recall")},
                             **{f"{k}_fresh": h[k] for k in ("dice", "iou", "precision", "recall")},
                             "max_abs_diff": max(abs(s[k] - h[k]) for k in ("dice", "iou", "precision", "recall"))})
        report["stored_vs_fresh_historic"] = {
            "stored_source": "ml/baseline/BASELINE_v1.json recorded_test_metrics (ml/results/test_metrics.json)",
            "stored_mean_dice": stored["mean_dice"], "fresh_mean_dice": macro["dice"],
            "max_abs_diff_any_metric": max(r["max_abs_diff"] for r in rows) if rows else None,
            "per_scene": rows,
            "note": "Both are retained. Applies only when the checkpoint evaluated is the frozen baseline.",
        }
    except Exception as e:  # pragma: no cover
        report["stored_vs_fresh_historic"] = {"error": str(e)}

    if not a.skip_leakage:
        print("[leakage] checking train/val and test/train overlaps ...", flush=True)
        report["leakage"] = leakage_report(root)

    sha_after = sha256(ck)
    report["checkpoint"]["sha256_after"] = sha_after
    report["checkpoint"]["unchanged"] = sha_after == sha_before
    report["frozen_baseline_sha256_at_end"] = sha256(FROZEN)
    report["frozen_baseline_unchanged"] = report["frozen_baseline_sha256_at_end"] == frozen_sha_before
    report["duration_seconds"] = round(time.time() - t0, 1)

    out = a.out or os.path.join(PROJECT_ROOT, "ml", "results", f"eval_{a.label}.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    assert os.path.basename(out) != "test_metrics.json", "the historical record is never overwritten"
    with open(out, "w") as f:
        json.dump(report, f, indent=2, default=lambda o: o.isoformat() if hasattr(o, "isoformat") else str(o))
    print(f"[eval] wrote {os.path.relpath(out, PROJECT_ROOT)} in {report['duration_seconds']} s | frozen baseline unchanged: {report['frozen_baseline_unchanged']}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
