"""
Run the FROZEN U-Net checkpoint on a real, georeferenced Sentinel-1 scene and vectorise the result.

    SAR GeoTIFF -> tiled inference -> probability raster -> thresholded mask -> geospatial polygons

Outputs (ml/results/inference/<scene>/):
  unet_probability_<norm>.tif      float32 probability, same grid/CRS as the input
  unet_mask_<norm>.tif             uint8 mask (probability >= threshold)
  unet_geometry_<norm>.json        polygons in EPSG:4326 with FULL provenance     -> provenance MODEL_PREDICTION
  reference_label_geometry.json    polygons vectorised from the labelled mask     -> provenance REFERENCE_LABEL
                                   (evaluation-only; never presented as a model prediction)

The checkpoint is only READ (sha256 recorded before/after). Dice/IoU/precision/recall in the geometry file
are MEASURED here against the reference label of this same scene; they are not copied from any registry.

    AEGIS_DATA_ROOT=... python ml/inference/run_unet_scene.py --normalization scene
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
import time
from datetime import datetime, timezone
from typing import Dict, List, Tuple

import numpy as np

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, PROJECT_ROOT)

from ml.data_root import radar_dataset_root, resolve_data  # noqa: E402
from ml.evaluation.protocol import confusion, metrics_from_confusion, tile_predict  # noqa: E402
from ml.evaluation.run_eval import FROZEN, load_model, make_predictor, sha256  # noqa: E402

SCENE_ID = "GOM_S1A_20180926_REAL"
SCENE_FILE = "2018_09_26.tif"
THRESHOLD = 0.5
MIN_COMPONENT_PX = 500          # 0.05 km2 at 10 m; smaller connected components are dropped (and counted)
SIMPLIFY_TOL_M = 15.0           # Douglas-Peucker tolerance in the projected CRS (1.5 px)
MAX_POLYGONS = 25


def _dp(points: np.ndarray, tol: float) -> np.ndarray:
    """Iterative Douglas-Peucker on an (N, 2) open polyline."""
    n = len(points)
    if n < 3:
        return points
    keep = np.zeros(n, bool)
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        p, q = points[a], points[b]
        seg = q - p
        d = points[a + 1:b] - p
        denom = math.hypot(*seg)
        dist = np.hypot(d[:, 0], d[:, 1]) if denom == 0 else np.abs(seg[0] * d[:, 1] - seg[1] * d[:, 0]) / denom
        i = int(np.argmax(dist))
        if dist[i] > tol:
            k = a + 1 + i
            keep[k] = True
            stack.extend([(a, k), (k, b)])
    return points[keep]


def _simplify_ring(ring: np.ndarray, tol: float) -> np.ndarray:
    """Simplify a closed ring (first == last) keeping it closed and valid-sized."""
    open_pts = ring[:-1]
    if len(open_pts) < 8:
        return ring
    # split at the two most distant points so DP is well conditioned
    i0 = 0
    i1 = int(np.argmax(np.hypot(*(open_pts - open_pts[0]).T)))
    a = _dp(open_pts[i0:i1 + 1], tol)
    b = _dp(np.vstack([open_pts[i1:], open_pts[:1]]), tol)
    out = np.vstack([a[:-1], b])
    if len(out) < 4:
        return ring
    return np.vstack([out, out[:1]])


def _shoelace(xy: np.ndarray) -> float:
    x, y = xy[:, 0], xy[:, 1]
    return 0.5 * float(np.dot(x[:-1], y[1:]) - np.dot(x[1:], y[:-1]))


def _axis_deg(rows: np.ndarray, cols: np.ndarray, transform) -> float:
    """Compass bearing (0-180, clockwise from north) of the principal axis of a pixel set (projected metres)."""
    if rows.size < 3:
        return 0.0
    x = transform.a * cols + transform.c
    y = transform.e * rows + transform.f
    cov = np.cov(np.vstack([x - x.mean(), y - y.mean()]))
    w, v = np.linalg.eigh(cov)
    vx, vy = v[:, int(np.argmax(w))]                # east, north components of the major axis
    return float((math.degrees(math.atan2(vx, vy)) + 360.0) % 180.0)


def vectorise(mask: np.ndarray, transform, crs, provenance: str) -> Dict[str, object]:
    import rasterio.features
    from rasterio.warp import transform_geom

    m = mask.astype(np.uint8)
    comps: List[Dict[str, object]] = []
    dropped_px = 0
    n_components = 0
    for geom, val in rasterio.features.shapes(m, mask=m == 1, transform=transform, connectivity=8):
        n_components += 1
        ring = np.asarray(geom["coordinates"][0], dtype=float)
        holes = geom["coordinates"][1:]
        area_m2 = abs(_shoelace(ring)) - sum(abs(_shoelace(np.asarray(h, float))) for h in holes)
        px = int(round(area_m2 / abs(transform.a * transform.e)))
        if px < MIN_COMPONENT_PX:
            dropped_px += px
            continue
        simp = _simplify_ring(ring, SIMPLIFY_TOL_M)
        ll = transform_geom(crs, "EPSG:4326", {"type": "Polygon", "coordinates": [simp.tolist()]})["coordinates"][0]
        ll = [[round(x, 6), round(y, 6)] for x, y in ll]
        lon = [p[0] for p in ll]; lat = [p[1] for p in ll]
        comps.append({"ring": ll, "area_km2": round(area_m2 / 1e6, 4), "pixel_count": px,
                      "bbox": [min(lon), min(lat), max(lon), max(lat)], "n_vertices": len(ll), "n_holes": len(holes),
                      "_proj_ring": ring})
    comps.sort(key=lambda c: -c["pixel_count"])
    kept = comps[:MAX_POLYGONS]
    dropped_extra = sum(c["pixel_count"] for c in comps[MAX_POLYGONS:])
    rows, cols = np.nonzero(m)
    total_px = int(m.sum())
    # centroid of ALL predicted pixels (lat, lon)
    if total_px:
        cx = transform.a * (cols.mean() + 0.5) + transform.c
        cy = transform.e * (rows.mean() + 0.5) + transform.f
        cll = transform_geom(crs, "EPSG:4326", {"type": "Point", "coordinates": (cx, cy)})["coordinates"]
        centroid = [round(cll[1], 6), round(cll[0], 6)]
    else:
        centroid = None
    for c in kept:
        c.pop("_proj_ring", None)
    lons = [p[0] for c in kept for p in c["ring"]]; lats = [p[1] for c in kept for p in c["ring"]]
    return {
        "provenance": provenance,
        "n_connected_components": n_components,
        "polygons": kept,
        "total_pixel_count": total_px,
        "total_area_km2": round(total_px * abs(transform.a * transform.e) / 1e6, 4),
        "dropped_small_component_pixels": int(dropped_px + dropped_extra),
        "min_component_area_px": MIN_COMPONENT_PX,
        "simplify_tolerance_m": SIMPLIFY_TOL_M,
        "centroid": centroid,
        "bbox": [min(lons), min(lats), max(lons), max(lats)] if kept else None,
        "orientation_deg": round(_axis_deg(rows, cols, transform), 1) if total_px else None,
        "orientation_source": "principal axis of the mask pixels (second moments, projected metres; compass bearing, axial 0-180)",
        # backwards-compatible single ring = the largest component
        "coordinates": kept[0]["ring"] if kept else [],
    }


def main(argv=None) -> int:
    import rasterio

    ap = argparse.ArgumentParser()
    ap.add_argument("--normalization", choices=["scene", "patch"], default="scene")
    ap.add_argument("--checkpoint", default=FROZEN)
    ap.add_argument("--scene", default=None, help="path to the SAR GeoTIFF (default: <data root>/data/sentinel1/real/2018_09_26.tif)")
    ap.add_argument("--out-dir", default=os.path.join(PROJECT_ROOT, "ml", "results", "inference", "2018_09_26"))
    a = ap.parse_args(argv)

    scene_path = a.scene or str(resolve_data("data", "sentinel1", "real", SCENE_FILE) or "")
    if not scene_path or not os.path.isfile(scene_path):
        print("SAR scene not found. Set AEGIS_DATA_ROOT to the folder containing data/sentinel1/real/2018_09_26.tif", file=sys.stderr)
        return 2
    ref_mask_path = os.path.join(str(radar_dataset_root()), "test", "masks", SCENE_FILE)

    ck = os.path.abspath(a.checkpoint)
    sha_before, frozen_before = sha256(ck), sha256(FROZEN)
    t0 = time.time()
    import torch
    model, device, ck_meta = load_model(ck)
    predict = make_predictor(model, device)

    with rasterio.open(scene_path) as src:
        image = src.read(1).astype(np.float32)
        profile, transform, crs = src.profile.copy(), src.transform, src.crs
    print(f"[infer] scene {os.path.basename(scene_path)} {image.shape} {crs} | device {device} | normalization={a.normalization}", flush=True)

    prob = tile_predict(image, predict, tile=256, overlap=32, normalization=a.normalization)
    mask = prob >= THRESHOLD
    os.makedirs(a.out_dir, exist_ok=True)
    pp = dict(profile, dtype="float32", count=1, compress="deflate", predictor=3, nodata=None)
    with rasterio.open(os.path.join(a.out_dir, f"unet_probability_{a.normalization}.tif"), "w", **pp) as d:
        d.write(prob.astype(np.float32), 1)
    mp = dict(profile, dtype="uint8", count=1, compress="deflate", nodata=None)
    mp.pop("predictor", None)
    with rasterio.open(os.path.join(a.out_dir, f"unet_mask_{a.normalization}.tif"), "w", **mp) as d:
        d.write(mask.astype(np.uint8), 1)

    # ---- polygons (MODEL_PREDICTION)
    geo = vectorise(mask, transform, crs, "MODEL_PREDICTION")

    # ---- measured comparison against the REFERENCE_LABEL of this scene (evaluation only)
    measured = None
    ref_geo = None
    if os.path.isfile(ref_mask_path):
        with rasterio.open(ref_mask_path) as s:
            ref = s.read(1) > 0.5
            assert s.transform == transform and s.shape == image.shape, "reference mask is not on the SAR grid"
        c = confusion(mask, ref)
        measured = {**c, **metrics_from_confusion(c), "n_reference_pixels": int(ref.sum()), "n_predicted_pixels": int(mask.sum()),
                    "how": "computed by ml/inference/run_unet_scene.py on this scene, this checkpoint, this protocol"}
        ref_geo = vectorise(ref, transform, crs, "REFERENCE_LABEL")

    # scene footprint (lon/lat bbox of the raster's four corners) so consumers never need a hard-coded box
    from rasterio.warp import transform as _tf
    h_, w_ = image.shape
    xs_ = [transform.c, transform.c + transform.a * w_]; ys_ = [transform.f, transform.f + transform.e * h_]
    lon_, lat_ = _tf(crs, "EPSG:4326", [xs_[0], xs_[1], xs_[0], xs_[1]], [ys_[0], ys_[0], ys_[1], ys_[1]])
    footprint = [round(min(lon_), 5), round(min(lat_), 5), round(max(lon_), 5), round(max(lat_), 5)]

    stamp = {
        "schema": "aegis.detection_geometry.v1",
        "scene_id": SCENE_ID,
        "created_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source_raster": {"file": os.path.basename(scene_path), "sha256": sha256(scene_path), "crs": str(crs), "pixel_size_m": abs(transform.a),
                          "shape": list(image.shape), "footprint_bbox_lonlat": footprint, "role": "Sentinel-1 VV backscatter (dB-like float32) from the labelled dataset; identical to the held-out test image"},
        "model": {"name": "unet_oil_spill_best", "checkpoint_sha256": sha_before, "epoch": ck_meta.get("epoch"), "status": "frozen production baseline"},
        "inference": {"normalization": a.normalization, "tiling": "256 px tiles, 32 px overlap, reflect-padded, overlap-averaged", "threshold": THRESHOLD, "device": str(device),
                      "seconds": round(time.time() - t0, 1)},
        "prediction_stats": {"max_probability": float(prob.max()), "mean_probability": float(prob.mean()), "predicted_pixels": int(mask.sum())},
        "measured_vs_reference_label": measured,
        "measured_vs_reference_label_note": "Evaluation-only. The reference label is never used to produce or alter the prediction.",
        **geo,
    }
    out = os.path.join(a.out_dir, f"unet_geometry_{a.normalization}.json")
    json.dump(stamp, open(out, "w"), indent=1)
    if ref_geo is not None and a.normalization == "scene":     # reference geometry does not depend on the model
        json.dump({"schema": "aegis.detection_geometry.v1", "scene_id": SCENE_ID, "created_utc": stamp["created_utc"],
                   "source_mask": {"file": SCENE_FILE, "sha256": sha256(ref_mask_path), "dataset": "Zenodo 10.5281/zenodo.4672426 (annotations from NOAA reports)"},
                   "note": "REFERENCE_LABEL vectorised from the labelled mask. Evaluation only; NOT a model prediction.", **ref_geo},
                  open(os.path.join(a.out_dir, "reference_label_geometry.json"), "w"), indent=1)

    assert sha256(ck) == sha_before and sha256(FROZEN) == frozen_before, "checkpoint changed!"
    print(json.dumps({"normalization": a.normalization, "predicted_px": int(mask.sum()), "polygons": len(geo["polygons"]), "components": geo["n_connected_components"],
                      "largest_km2": geo["polygons"][0]["area_km2"] if geo["polygons"] else None, "centroid": geo["centroid"], "axis_deg": geo["orientation_deg"],
                      "measured": {k: round(measured[k], 4) for k in ("dice", "iou", "precision", "recall", "pixel_false_positive_rate")} if measured else None,
                      "checkpoint_unchanged": True}, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
