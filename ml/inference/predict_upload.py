#!/usr/bin/env python3
"""
Run the FROZEN U-Net checkpoint on an UPLOADED raster and report the result as JSON.

This is the upload entry point used by the web server (POST /api/uploads/sar). It reuses the existing
inference code unchanged:
    ml/evaluation/protocol.py      tile_predict (whole-scene z-score, 256 px tiles, 32 px overlap)
    ml/evaluation/run_eval.py      load_model / make_predictor (frozen checkpoint, read-only)
    ml/inference/run_unet_scene.py vectorise (connected components -> EPSG:4326 polygons)

Nothing is retrained and no checkpoint is written; the checkpoint SHA-256 is recorded before and after.

Honesty rules enforced here:
  * The model was trained on Sentinel-1 VV backscatter (continuous, dB-like). 8-bit imagery (JPEG/PNG
    photographs, screenshots, RGB quicklooks) is REJECTED rather than scored - it is not SAR backscatter.
  * Model probabilities are NOT calibrated. They are reported as raw model output, never as "confidence".
  * A result on any raster outside the training distribution is flagged as out-of-distribution.
  * Without a CRS the prediction cannot be given a location or an area in km2; it is reported in pixels.

    python3 ml/inference/predict_upload.py --input FILE --out-dir DIR
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
from datetime import datetime, timezone

import numpy as np

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, PROJECT_ROOT)

THRESHOLD = 0.5
MIN_COMPONENT_PX = 500          # same speck filter as the main real-scene pipeline
MAX_PIXELS = 120_000_000        # refuse absurd rasters instead of hanging
MIN_SIDE = 64
PREVIEW_MAX = 1400              # px, longest side of the PNG previews


def fail(reason: str, detail: str = "", **extra):
    out = {"schema": "aegis.upload_prediction.v1", "ok": False, "reason": reason, "detail": detail}
    out.update(extra)
    print(json.dumps(out))
    return 0                     # a rejected upload is a normal outcome, not a crash


def stretch_to_uint8(a: np.ndarray) -> np.ndarray:
    """2-98 percentile stretch for display only (never used for inference)."""
    finite = np.isfinite(a)
    if not finite.any():
        return np.zeros(a.shape, np.uint8)
    lo, hi = np.percentile(a[finite], [2, 98])
    if not math.isfinite(lo) or not math.isfinite(hi) or hi <= lo:
        lo, hi = float(np.nanmin(a[finite])), float(np.nanmax(a[finite]))
    if hi <= lo:
        return np.zeros(a.shape, np.uint8)
    v = (np.clip(np.nan_to_num(a, nan=lo, posinf=hi, neginf=lo), lo, hi) - lo) / (hi - lo)
    return (v * 255).astype(np.uint8)


def write_previews(image: np.ndarray, mask: np.ndarray, out_dir: str) -> dict:
    """Downsampled grayscale preview of the input, plus the same image with predicted pixels in red."""
    from PIL import Image

    h, w = image.shape
    step = max(1, int(math.ceil(max(h, w) / PREVIEW_MAX)))
    small = image[::step, ::step]
    small_mask = mask[::step, ::step]
    g = stretch_to_uint8(small)
    Image.fromarray(g, mode="L").save(os.path.join(out_dir, "preview.png"), optimize=True)

    rgb = np.stack([g, g, g], axis=-1)
    rgb[small_mask] = [220, 48, 58]                       # predicted oil pixels
    Image.fromarray(rgb, mode="RGB").save(os.path.join(out_dir, "overlay.png"), optimize=True)
    return {"preview_scale_step": step, "preview_size": [int(small.shape[1]), int(small.shape[0])]}


def component_pixels(mask: np.ndarray, transform) -> tuple:
    """(kept_pixels, dropped_pixels, n_components) using the same >=MIN_COMPONENT_PX speck filter."""
    import rasterio.features

    m = mask.astype(np.uint8)
    kept = dropped = 0
    n = 0
    for geom, _ in rasterio.features.shapes(m, mask=m == 1, transform=transform, connectivity=8):
        n += 1
        ring = np.asarray(geom["coordinates"][0], float)
        x, y = ring[:, 0], ring[:, 1]
        area = abs(0.5 * float(np.dot(x[:-1], y[1:]) - np.dot(x[1:], y[:-1])))
        holes = sum(
            abs(0.5 * float(np.dot(np.asarray(hh, float)[:-1, 0], np.asarray(hh, float)[1:, 1]) -
                            np.dot(np.asarray(hh, float)[1:, 0], np.asarray(hh, float)[:-1, 1])))
            for hh in geom["coordinates"][1:]
        )
        px = int(round((area - holes) / abs(transform.a * transform.e)))
        if px >= MIN_COMPONENT_PX:
            kept += px
        else:
            dropped += px
    return kept, dropped, n


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--original-name", default=None)
    a = ap.parse_args(argv)

    t0 = time.time()
    os.makedirs(a.out_dir, exist_ok=True)
    name = a.original_name or os.path.basename(a.input)

    try:
        import rasterio
        from rasterio.transform import Affine
    except ImportError as e:
        return fail("MODEL_RUNTIME_UNAVAILABLE", f"rasterio is not installed in this environment ({e}).")
    try:
        import torch  # noqa: F401
    except ImportError as e:
        return fail("MODEL_RUNTIME_UNAVAILABLE", f"PyTorch is not installed in this environment ({e}).")

    # ---------------------------------------------------------------- open + validate
    try:
        src = rasterio.open(a.input)
    except Exception as e:
        return fail(
            "UNSUPPORTED_INPUT",
            f"The file could not be read as a raster ({type(e).__name__}). The current model needs a "
            "single-band Sentinel-1 style GeoTIFF of SAR backscatter.",
            filename=name,
        )

    with src:
        w, h, count, dtype = src.width, src.height, src.count, src.dtypes[0]
        crs = src.crs
        transform = src.transform
        info = {
            "filename": name,
            "driver": src.driver,
            "width": w,
            "height": h,
            "bands": count,
            "dtype": str(dtype),
            "crs": str(crs) if crs else None,
            "georeferenced": bool(crs),
            "pixel_size": [abs(transform.a), abs(transform.e)] if transform else None,
        }

        if w < MIN_SIDE or h < MIN_SIDE:
            return fail("UNSUPPORTED_INPUT", f"Image is {w}x{h} px; at least {MIN_SIDE}x{MIN_SIDE} is required.", input=info, filename=name)
        if w * h > MAX_PIXELS:
            return fail("INPUT_TOO_LARGE", f"Image has {w * h:,} pixels; this endpoint accepts up to {MAX_PIXELS:,}.", input=info, filename=name)
        if str(dtype) == "uint8":
            return fail(
                "UNSUPPORTED_INPUT",
                "Unsupported image format/input for the current SAR model: this is 8-bit imagery "
                "(photograph, screenshot or RGB quicklook). The model expects continuous Sentinel-1 VV "
                "backscatter (dB-like float), not a picture of a scene.",
                input=info, filename=name,
            )
        if count >= 3:
            return fail(
                "UNSUPPORTED_INPUT",
                f"Unsupported image format/input for the current SAR model: {count} bands look like a colour "
                "image. The model takes one VV backscatter band.",
                input=info, filename=name,
            )

        image = src.read(1).astype(np.float32)
        nodata = src.nodata
        if crs is not None and transform is not None:
            try:
                from rasterio.warp import transform as _tf
                xs = [transform.c, transform.c + transform.a * w]
                ys = [transform.f, transform.f + transform.e * h]
                lon, lat = _tf(crs, "EPSG:4326", [xs[0], xs[1], xs[0], xs[1]], [ys[0], ys[0], ys[1], ys[1]])
                info["footprint_bbox_lonlat"] = [round(min(lon), 6), round(min(lat), 6), round(max(lon), 6), round(max(lat), 6)]
            except Exception:
                info["footprint_bbox_lonlat"] = None

    finite = np.isfinite(image)
    if not finite.any():
        return fail("UNSUPPORTED_INPUT", "The raster contains no finite values (entirely nodata).", input=info, filename=name)
    if nodata is not None:
        image = np.where(image == nodata, np.nan, image)
        finite = np.isfinite(image)
        if not finite.any():
            return fail("UNSUPPORTED_INPUT", "Every pixel equals the raster's nodata value.", input=info, filename=name)

    vals = image[finite]
    stats = {"min": float(vals.min()), "max": float(vals.max()), "mean": float(vals.mean()), "finite_fraction": float(finite.mean())}
    # the training data is Sentinel-1 VV sigma0 in dB, roughly -50..+30
    in_distribution = bool(-60.0 <= stats["min"] and stats["max"] <= 40.0)

    # ---------------------------------------------------------------- model
    from ml.evaluation.protocol import tile_predict
    from ml.evaluation.run_eval import FROZEN, load_model, make_predictor, sha256
    from ml.inference.run_unet_scene import vectorise

    sha_before = sha256(FROZEN)
    model, device, ck_meta = load_model(FROZEN)
    predict = make_predictor(model, device)
    prob = tile_predict(image, predict, tile=256, overlap=32, normalization="scene")
    mask = prob >= THRESHOLD
    sha_after = sha256(FROZEN)

    px_transform = transform if transform else Affine.identity()
    kept_px, dropped_px, n_comp = component_pixels(mask, px_transform)
    detected = kept_px > 0

    geometry = None
    area_km2 = None
    if crs is not None:
        try:
            geometry = vectorise(mask, transform, crs, "MODEL_PREDICTION")
            pix_m2 = abs(transform.a * transform.e)
            area_km2 = round(kept_px * pix_m2 / 1e6, 4) if pix_m2 else None
        except Exception as e:  # projection problems must not crash the upload
            geometry = None
            info["vectorise_error"] = f"{type(e).__name__}: {e}"

    previews = write_previews(image, mask, a.out_dir)

    notes = []
    if not in_distribution:
        notes.append(
            f"Pixel values range {stats['min']:.1f} to {stats['max']:.1f}, outside the Sentinel-1 VV dB range the "
            "model was trained on. The result is out-of-distribution and should not be trusted."
        )
    if crs is None:
        notes.append("The raster has no CRS, so the prediction has no location and no area in km2. Pixel counts only.")
    if dropped_px:
        notes.append(f"{dropped_px} isolated predicted pixels were below the {MIN_COMPONENT_PX} px component filter and are not counted as a slick.")
    notes.append("Model probabilities are not calibrated; the values below are raw model output, not a confidence.")
    notes.append("A SAR dark feature can also be low wind, a biogenic film or a rain cell. Detection is not proof of petroleum.")

    result = {
        "schema": "aegis.upload_prediction.v1",
        "ok": True,
        "created_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "input": {**info, "value_stats": stats, "in_training_value_range": in_distribution},
        "model": {
            "name": "unet_oil_spill_best",
            "checkpoint": "ml/checkpoints/unet_oil_spill_best.pth",
            "checkpoint_sha256": sha_before,
            "checkpoint_unchanged": sha_before == sha_after,
            "epoch": ck_meta.get("epoch"),
            "threshold": THRESHOLD,
            "normalization": "whole-scene z-score",
            "tiling": "256 px tiles, 32 px overlap, reflect-padded, overlap-averaged",
            "device": str(device),
        },
        "prediction": {
            "detected": detected,
            "positive_pixels": int(mask.sum()),
            "pixels_in_kept_components": int(kept_px),
            "pixels_dropped_as_specks": int(dropped_px),
            "connected_components": int(n_comp),
            "positive_fraction": round(float(mask.mean()), 6),
            "max_probability": round(float(prob.max()), 6),
            "mean_probability": round(float(prob.mean()), 6),
            "probability_is_calibrated": False,
            "area_km2": area_km2,
        },
        "geometry": geometry,
        "previews": {"preview": "preview.png", "overlay": "overlay.png", **previews},
        "investigable": bool(detected and geometry and geometry.get("polygons")),
        "notes": notes,
        "duration_seconds": round(time.time() - t0, 2),
    }
    with open(os.path.join(a.out_dir, "result.json"), "w") as f:
        json.dump(result, f)
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
