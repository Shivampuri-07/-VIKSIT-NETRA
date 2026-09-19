"""
Unified segmentation evaluation protocol (NumPy only; any predictor).

Fixes the audited gaps of ml/inference/test_model.py WITHOUT changing the
frozen baseline record:
  * full coverage: overlapping tiles + reflect padding (no unpredicted edges)
  * explicit normalisation choice ("scene" or "patch") so a model is scored
    with the preprocessing it was trained with
  * pooled (micro) AND per-scene (macro) metrics
  * false-positive behaviour: pixel false-positive rate, false-alarm scenes
  * calibration: reliability bins, expected calibration error (ECE), Brier score

predict_patch(tile) receives one (tile, tile) float32 array already normalised
and must return oil probabilities of the same shape.
"""
from __future__ import annotations

from typing import Callable, Dict, Iterable, List, Tuple

import numpy as np


def zscore(image: np.ndarray) -> np.ndarray:
    image = image.astype(np.float32)
    valid = np.isfinite(image)
    if not valid.any():
        return np.zeros_like(image)
    v = image[valid]
    out = (image - v.mean()) / (v.std() + 1e-6)
    return np.nan_to_num(out, nan=0.0, posinf=0.0, neginf=0.0).astype(np.float32)


def tile_predict(image: np.ndarray, predict_patch: Callable[[np.ndarray], np.ndarray], tile: int = 256,
                 overlap: int = 32, normalization: str = "scene") -> np.ndarray:
    """Probability map covering EVERY pixel (overlap-averaged; edges reflect-padded)."""
    if normalization not in ("scene", "patch"):
        raise ValueError("normalization must be 'scene' or 'patch'")
    img = image.astype(np.float32)
    if normalization == "scene":
        # identical to ml/inference/real_scene_inference.py (finite pixels; nan_to_num BEFORE scaling)
        valid = np.isfinite(img)
        mean, std = img[valid].mean(), img[valid].std()
        img = (np.nan_to_num(img, nan=0.0, posinf=0.0, neginf=0.0) - mean) / (std + 1e-6)
    h, w = img.shape
    stride = tile - overlap
    prob = np.zeros((h, w), np.float64)
    count = np.zeros((h, w), np.float64)
    for r in range(0, h, stride):
        for c in range(0, w, stride):
            r2, c2 = min(r + tile, h), min(c + tile, w)
            t = img[r:r2, c:c2]
            if t.shape != (tile, tile):
                t = np.pad(t, ((0, tile - t.shape[0]), (0, tile - t.shape[1])), mode="reflect")
            if normalization == "patch":
                t = zscore(t)
            p = np.asarray(predict_patch(t.astype(np.float32)), np.float64)[: r2 - r, : c2 - c]
            prob[r:r2, c:c2] += p
            count[r:r2, c:c2] += 1
    assert count.min() >= 1, "tiling left pixels uncovered"
    return (prob / count).astype(np.float32)


def confusion(pred: np.ndarray, gt: np.ndarray) -> Dict[str, int]:
    p, g = pred.astype(bool), gt.astype(bool)
    return {"tp": int((p & g).sum()), "fp": int((p & ~g).sum()), "fn": int((~p & g).sum()), "tn": int((~p & ~g).sum())}


def metrics_from_confusion(c: Dict[str, int], eps: float = 1e-9) -> Dict[str, float]:
    tp, fp, fn, tn = c["tp"], c["fp"], c["fn"], c["tn"]
    return {
        "dice": (2 * tp) / (2 * tp + fp + fn + eps) if (tp + fp + fn) else 1.0,
        "iou": tp / (tp + fp + fn + eps) if (tp + fp + fn) else 1.0,
        "precision": tp / (tp + fp + eps) if (tp + fp) else float("nan"),
        "recall": tp / (tp + fn + eps) if (tp + fn) else float("nan"),
        "pixel_false_positive_rate": fp / (fp + tn + eps) if (fp + tn) else float("nan"),
    }


def calibration(probs: np.ndarray, gt: np.ndarray, n_bins: int = 10) -> Dict[str, object]:
    p = np.clip(probs.astype(np.float64).ravel(), 0, 1)
    y = gt.astype(bool).ravel().astype(np.float64)
    edges = np.linspace(0, 1, n_bins + 1)
    idx = np.clip(np.digitize(p, edges[1:-1]), 0, n_bins - 1)
    bins, ece = [], 0.0
    for b in range(n_bins):
        m = idx == b
        n = int(m.sum())
        if n:
            conf, acc = float(p[m].mean()), float(y[m].mean())
            ece += n / p.size * abs(conf - acc)
            bins.append({"lo": float(edges[b]), "hi": float(edges[b + 1]), "count": n, "mean_prob": conf, "fraction_oil": acc})
    return {"ece": float(ece), "brier": float(np.mean((p - y) ** 2)), "n_pixels": int(p.size), "bins": bins}


def evaluate_scenes(scenes: Iterable[Tuple[str, np.ndarray, np.ndarray]], predict_patch, threshold: float = 0.5,
                    normalization: str = "scene", min_false_alarm_px: int = 50, calib_sample: int = 200_000,
                    seed: int = 0) -> Dict[str, object]:
    rng = np.random.default_rng(seed)
    per_scene: List[Dict[str, object]] = []
    pooled = {"tp": 0, "fp": 0, "fn": 0, "tn": 0}
    cp, cg = [], []
    false_alarm_scenes, empty_scenes = 0, 0
    for name, image, mask in scenes:
        gt = mask > 0.5
        prob = tile_predict(image, predict_patch, normalization=normalization)
        c = confusion(prob >= threshold, gt)
        for k in pooled:
            pooled[k] += c[k]
        m = metrics_from_confusion(c)
        if not gt.any():
            empty_scenes += 1
            if c["fp"] >= min_false_alarm_px:
                false_alarm_scenes += 1
        per_scene.append({"scene": name, **c, **m})
        k = min(calib_sample, prob.size)
        sel = rng.choice(prob.size, size=k, replace=False)
        cp.append(prob.ravel()[sel]); cg.append(gt.ravel()[sel])
    macro = {k: float(np.nanmean([s[k] for s in per_scene])) for k in ("dice", "iou", "precision", "recall", "pixel_false_positive_rate")} if per_scene else {}
    return {
        "protocol": {"threshold": threshold, "normalization": normalization, "tiling": "256 px, 32 px overlap, reflect-padded edges (full coverage)",
                     "false_alarm_definition": f"scene without labelled oil but >= {min_false_alarm_px} predicted pixels"},
        "n_scenes": len(per_scene),
        "pooled": {**pooled, **metrics_from_confusion(pooled)},
        "macro_mean": macro,
        "false_alarm_scenes": false_alarm_scenes,
        "scenes_without_oil": empty_scenes,
        "calibration": calibration(np.concatenate(cp), np.concatenate(cg)) if cp else None,
        "per_scene": per_scene,
    }
