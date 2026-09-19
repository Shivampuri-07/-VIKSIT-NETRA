"""
Validates a manifest of LABELLED SAR scenes before any data is used for
training or evaluation (e.g. proposed 2023-2026 data). Rejects unlabelled
imagery and model predictions as ground truth, checks provenance fields,
split leakage and the geographic/temporal distribution.

    python ml/data/validate_labelled_manifest.py manifest.csv [--check-files ROOT]
See ml/data/DATA_PROTOCOL.md for the column definitions.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import os
import sys
from datetime import datetime

REQUIRED = ["scene_id", "sensor", "polarization", "acquisition_utc", "lon_min", "lat_min", "lon_max", "lat_max",
            "image_path", "mask_path", "label_source", "label_method", "annotator", "license", "split"]
SENSORS = {"Sentinel-1A", "Sentinel-1B", "Sentinel-1C", "RADARSAT-2", "RCM", "TerraSAR-X", "COSMO-SkyMed", "ICEYE", "ALOS-2"}
REJECTED_LABEL_SOURCES = {"", "none", "unlabelled", "unlabeled", "model_prediction", "pseudo_label", "self_training", "automatic"}
SPLITS = {"train", "val", "test"}


def _f(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return float("nan")


def validate(rows, check_root=None, near_km=50.0, near_days=3.0):
    errors, warnings = [], []
    seen = {}
    parsed = []
    for i, r in enumerate(rows, start=2):
        miss = [k for k in REQUIRED if not str(r.get(k, "")).strip()]
        if miss:
            errors.append(f"row {i}: missing {miss}")
            continue
        sid = r["scene_id"].strip()
        if r["sensor"] not in SENSORS:
            errors.append(f"row {i} {sid}: unknown sensor '{r['sensor']}'")
        if r["label_source"].strip().lower() in REJECTED_LABEL_SOURCES:
            errors.append(f"row {i} {sid}: label_source '{r['label_source']}' is not ground truth (unlabelled or model-generated labels are rejected)")
        if r["split"] not in SPLITS:
            errors.append(f"row {i} {sid}: split must be train/val/test")
        try:
            t = datetime.fromisoformat(r["acquisition_utc"].replace("Z", "+00:00"))
        except ValueError:
            errors.append(f"row {i} {sid}: acquisition_utc not ISO-8601")
            continue
        box = [_f(r[k]) for k in ("lon_min", "lat_min", "lon_max", "lat_max")]
        if any(math.isnan(v) for v in box) or not (-180 <= box[0] < box[2] <= 180 and -90 <= box[1] < box[3] <= 90):
            errors.append(f"row {i} {sid}: invalid bounding box")
            continue
        if sid in seen and seen[sid] != r["split"]:
            errors.append(f"scene {sid} appears in both '{seen[sid]}' and '{r['split']}' (split leakage)")
        seen[sid] = r["split"]
        if check_root:
            for k in ("image_path", "mask_path"):
                if not os.path.isfile(os.path.join(check_root, r[k])):
                    errors.append(f"row {i} {sid}: {k} not found")
        parsed.append({"sid": sid, "split": r["split"], "t": t, "lat": (box[1] + box[3]) / 2, "lon": (box[0] + box[2]) / 2,
                       "sensor": r["sensor"], "label_source": r["label_source"]})
    # spatio-temporal leakage: test scenes very close in space AND time to training scenes
    train = [p for p in parsed if p["split"] == "train"]
    for p in [q for q in parsed if q["split"] == "test"]:
        for q in train:
            dkm = 111.195 * math.hypot(p["lat"] - q["lat"], (p["lon"] - q["lon"]) * math.cos(math.radians(p["lat"])))
            ddays = abs((p["t"] - q["t"]).total_seconds()) / 86400
            if dkm < near_km and ddays < near_days:
                warnings.append(f"test scene {p['sid']} is {dkm:.0f} km / {ddays:.1f} days from train scene {q['sid']} (likely the same event: leakage)")
    dist = {}
    for key in ("split", "sensor", "label_source"):
        dist[key] = {}
        for p in parsed:
            dist[key][p[key]] = dist[key].get(p[key], 0) + 1
    dist["year"] = {}
    for p in parsed:
        dist["year"][str(p["t"].year)] = dist["year"].get(str(p["t"].year), 0) + 1
    dist["region_1deg"] = len({(round(p["lat"]), round(p["lon"])) for p in parsed})
    return {"ok": not errors, "n_rows": len(rows), "n_valid": len(parsed), "errors": errors, "warnings": warnings, "distribution": dist}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("manifest")
    ap.add_argument("--check-files", default=None)
    a = ap.parse_args(argv)
    with open(a.manifest, newline="") as f:
        rep = validate(list(csv.DictReader(f)), a.check_files)
    print(json.dumps(rep, indent=2, default=str))
    return 0 if rep["ok"] else 2


if __name__ == "__main__":
    sys.exit(main())
