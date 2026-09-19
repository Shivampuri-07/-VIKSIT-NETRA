#!/usr/bin/env python3
"""
Build the FINAL release ZIP of this project (+ SHA-256 checksums). Standard library only.

INCLUDED   source, configs, tests, docs, the frozen checkpoint, the candidate run directory, small runtime data
           (data/sample, data/ais/2018, data/era5, data/currents, data/sentinel1/derived), evaluation/inference JSON,
           the built dist/ and dist-server/ (rebuildable), package-lock.json.
EXCLUDED   .env (secrets), node_modules, .venv, .git, caches/temp files, the labelled dataset and any other large
           external data (read from AEGIS_DATA_ROOT instead of being duplicated), model overlays (17 MB PNGs),
           probability rasters (regenerable), 2025 Sentinel-1 leftovers and their all-zero prediction tiles, logs of the
           running server.

    python3 scripts/package_release.py [--out /path/to/AEGIS-Sentinel-FINAL.zip]
"""
from __future__ import annotations

import argparse
import fnmatch
import hashlib
import os
import sys
import zipfile
from datetime import datetime, timezone

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

EXCLUDE_DIRS = {".git", "node_modules", ".venv", "venv", "env", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache",
                ".vite", "coverage", ".aistudio"}
EXCLUDE_GLOBS = [
    ".env", ".env.*", "*.pyc", ".DS_Store", "*.tsbuildinfo", "*.rar",
    "ml/datasets/radar_data/*",                    # the labelled dataset lives in AEGIS_DATA_ROOT, never duplicated
    "ml/results/overlays/*",                       # 2-17 MB PNG overlays
    "ml/results/inference/*/unet_probability_*.tif",  # ~40 MB each; regenerate with ml/inference/run_unet_scene.py
    "data/sentinel1/event_predictions/*",          # 462 all-zero tiles of an unusable 2025 run
    "data/sentinel1/*.png", "data/sentinel1/S1A_*.tif", "data/sentinel1/copernicus_*.tif",
    "ml/results/prod_server.log", "ml/results/*.pid",
    "*.zip", "*.zip.sha256",
]
EXCLUDE_FILES = {"PACKAGE_SHA256SUMS.txt"}          # regenerated below


def excluded(rel: str) -> bool:
    parts = rel.split("/")
    if any(p in EXCLUDE_DIRS for p in parts[:-1]) or parts[-1] in EXCLUDE_DIRS:
        return True
    name = parts[-1]
    if rel == ".env.example":                      # the empty template ships; real .env files never do
        return False
    if rel in EXCLUDE_FILES:
        return True
    for g in EXCLUDE_GLOBS:
        if fnmatch.fnmatch(rel, g) or fnmatch.fnmatch(name, g):
            return True
    return False


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(os.path.dirname(ROOT), "AEGIS-Sentinel-FINAL.zip"))
    a = ap.parse_args(argv)

    files = []
    for dp, dn, fn in os.walk(ROOT):
        dn[:] = sorted(d for d in dn if d not in EXCLUDE_DIRS)
        for f in sorted(fn):
            full = os.path.join(dp, f)
            rel = os.path.relpath(full, ROOT).replace(os.sep, "/")
            if not excluded(rel) and os.path.isfile(full) and not os.path.islink(full):
                files.append((rel, full))

    sums = [(rel, sha256_file(full)) for rel, full in files]
    sums_txt = "".join(f"{h}  {rel}\n" for rel, h in sums)

    prefix = "AEGIS-Sentinel-FINAL/"
    with zipfile.ZipFile(a.out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for rel, full in files:
            z.write(full, prefix + rel)
        z.writestr(prefix + "PACKAGE_SHA256SUMS.txt", sums_txt)
    total = os.path.getsize(a.out)
    zsha = sha256_file(a.out)
    with open(a.out + ".sha256", "w") as f:
        f.write(f"{zsha}  {os.path.basename(a.out)}\n")
    print(f"packaged {len(files)} files -> {a.out} ({total / 1e6:.1f} MB)")
    print(f"sha256 {zsha}")
    print("frozen checkpoint in package:", any(r == "ml/checkpoints/unet_oil_spill_best.pth" for r, _ in files),
          "| .env in package:", any(r.startswith(".env") and r != ".env.example" for r, _ in files),
          "| built", datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
