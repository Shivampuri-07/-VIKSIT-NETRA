"""
Verify the frozen production baseline (torch-free).

    python ml/verification/verify_baseline.py              # hash + structure checks
    python ml/verification/verify_baseline.py --reproduce  # + NumPy re-run of a stored inference (~20 s)

Exit code 0 only if every check passes. Nothing is ever written except with
--write-manifest (used once to create ml/baseline/BASELINE_v1.json).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from datetime import datetime, timezone

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, ROOT)
MANIFEST = os.path.join(ROOT, "ml", "baseline", "BASELINE_v1.json")
CHECKPOINT = "ml/checkpoints/unet_oil_spill_best.pth"
REPRO_INPUT = "data/sentinel1/copernicus_sigma0_test.tif"
REPRO_OUTPUT = "data/sentinel1/copernicus_oil_probability.tif"
# Visual-only artifacts (large PNG overlays): verified when present, not required.
OPTIONAL_PREFIXES = ("ml/results/overlays/",)


def sha256(rel: str) -> str:
    h = hashlib.sha256()
    with open(os.path.join(ROOT, rel), "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def artifact_list():
    arts = [CHECKPOINT, "ml/results/test_metrics.json", REPRO_INPUT, REPRO_OUTPUT]
    for d in ("ml/results/predictions", "ml/results/overlays"):
        arts += sorted(os.path.join(d, f) for f in os.listdir(os.path.join(ROOT, d)))
    return arts


def structure_check():
    from ml.verification.numpy_reference import read_torch_checkpoint, expected_state_dict_shapes
    ck = read_torch_checkpoint(os.path.join(ROOT, CHECKPOINT))
    sd = ck["model_state_dict"]
    exp = expected_state_dict_shapes()
    act = {k: tuple(v.shape) for k, v in sd.items()}
    meta = {k: (float(v) if not isinstance(v, int) else v) for k, v in ck.items() if k != "model_state_dict"}
    return {"keys_match": set(exp) == set(act), "shapes_match": all(exp[k] == act.get(k) for k in exp),
            "n_tensors": len(act), "n_parameters": int(sum(v.size for k, v in sd.items() if "num_batches" not in k)),
            "metadata": meta}, sd


def reproduce(sd):
    import numpy as np
    from ml.verification.numpy_reference import read_strip_tiff_band1, real_scene_recipe
    img = read_strip_tiff_band1(os.path.join(ROOT, REPRO_INPUT))
    ref = read_strip_tiff_band1(os.path.join(ROOT, REPRO_OUTPUT)).astype(np.float64)
    p = real_scene_recipe(img, sd).astype(np.float64)
    ad = np.abs(p - ref)
    return {"input": REPRO_INPUT, "stored_pytorch_output": REPRO_OUTPUT,
            "recipe": "ml/inference/real_scene_inference.py (whole-image z-score, 256 px tiles, 32 px overlap, reflect pad, overlap mean)",
            "max_abs_diff": float(ad.max()), "max_rel_diff": float((ad / np.maximum(ref, 1e-30)).max()),
            "numpy_max_prob": float(p.max()), "stored_max_prob": float(ref.max()),
            "pixels_ge_0_5_numpy": int((p >= 0.5).sum()), "pixels_ge_0_5_stored": int((ref >= 0.5).sum()),
            "passed": bool(ad.max() < 1e-6)}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--reproduce", action="store_true")
    ap.add_argument("--write-manifest", action="store_true")
    a = ap.parse_args(argv)
    struct_res, sd = structure_check()
    if a.write_manifest:
        tm = json.load(open(os.path.join(ROOT, "ml/results/test_metrics.json")))
        repro = reproduce(sd)
        manifest = {
            "schema": "aegis.baseline_manifest.v1",
            "baseline_id": "unet_oil_spill_best@33688d9b",
            "frozen_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "statement": "Production baseline. Must never be overwritten; candidates live in ml/checkpoints/candidates/. "
                         "Any candidate is compared against the recorded_test_metrics below on the SAME 7 held-out scenes.",
            "checkpoint": {"path": CHECKPOINT, "size_bytes": os.path.getsize(os.path.join(ROOT, CHECKPOINT)), "sha256": sha256(CHECKPOINT),
                           "structure": struct_res},
            "recorded_test_metrics": {"source": "ml/results/test_metrics.json (produced by ml/inference/test_model.py; not re-run here)",
                                      "mean_dice": tm["mean_dice"], "mean_iou": tm["mean_iou"],
                                      "mean_precision": tm["mean_precision"], "mean_recall": tm["mean_recall"],
                                      "per_scene": tm["images"]},
            "evaluation_protocol_as_implemented": {
                "script": "ml/inference/test_model.py",
                "test_scenes": [x["image"] for x in tm["images"]],
                "input_normalisation": "z-score over the finite pixels of the WHOLE scene",
                "tiling": "256 x 256, stride 256 (no overlap); right/bottom remainders narrower than 256 px are never predicted and count as 'no oil'",
                "threshold": 0.5,
                "mask_binarisation": "mask > 0.5",
                "aggregation": "metrics per scene, then unweighted mean over the 7 scenes",
            },
            "known_protocol_issues": [
                "Training normalises each 256 px PATCH (ml/datasets/dataset.py) but evaluation normalises the WHOLE SCENE: train/test preprocessing differ.",
                "Scene edges not covered by the non-overlapping tiling are scored as negative.",
                "The overlay PNGs cast z-scores*255 to uint8 (integer wrap-around): their grey background is not a faithful SAR rendering (metrics unaffected).",
                "real_scene_inference.py comments that its whole-image normalisation is 'the same normalization used during training': it is not.",
            ],
            "reproducibility_status": {
                "test_scene_reevaluation": "NOT RE-RUN: the 7 test scenes (Radar_data/test) are not in the repository and PyTorch is unavailable in the verification environment.",
                "independent_inference_reproduction": repro,
            },
            "artifacts_sha256": {p: sha256(p) for p in artifact_list()},
        }
        os.makedirs(os.path.dirname(MANIFEST), exist_ok=True)
        if os.path.exists(MANIFEST):
            print("manifest exists; refusing to overwrite", file=sys.stderr)
            return 3
        json.dump(manifest, open(MANIFEST, "w"), indent=1)
        print(f"wrote {MANIFEST}")
        return 0

    m = json.load(open(MANIFEST))
    ok = True
    optional_absent = 0
    for p, h in m["artifacts_sha256"].items():
        present = os.path.exists(os.path.join(ROOT, p))
        if not present and p.startswith(OPTIONAL_PREFIXES):
            optional_absent += 1  # visual-only files are not distributed via Git
            continue
        cur = sha256(p) if present else "MISSING"
        if cur != h:
            ok = False
            print(f"MISMATCH {p}: {cur} != {h}")
    if optional_absent:
        print(f"({optional_absent} optional visual-only artifacts not present: {', '.join(OPTIONAL_PREFIXES)})")
    print(f"artifact hashes: {'OK' if ok else 'FAILED'} ({len(m['artifacts_sha256'])} files)")
    s_ok = struct_res["keys_match"] and struct_res["shapes_match"]
    print(f"checkpoint structure vs ml/models/unet.py: {'OK' if s_ok else 'FAILED'} ({struct_res['n_tensors']} tensors, {struct_res['n_parameters']} parameters)")
    ok = ok and s_ok
    if a.reproduce:
        r = reproduce(sd)
        print(f"independent NumPy reproduction of stored PyTorch output: {'OK' if r['passed'] else 'FAILED'} (max |diff| {r['max_abs_diff']:.2e})")
        ok = ok and r["passed"]
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
