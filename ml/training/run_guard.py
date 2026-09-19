"""
Run guard for AEGIS model training (torch-free, so it can be tested and used
for data preflight on machines without PyTorch).

Guarantees
----------
* No training run can write to the production/baseline checkpoint
  (ml/checkpoints/unet_oil_spill_best.pth), whether addressed directly,
  through ".." segments, relative paths or symlinks.
* Every run writes only inside its own new directory under
  ml/checkpoints/candidates/<UTC timestamp>_<name>/ and never overwrites an
  existing file.
* A candidate is NOT promoted automatically. Promotion requires a benchmark
  against the frozen baseline on the same held-out test scenes (see
  ml/model_registry.json "policy"). More epochs (e.g. 6) are an experiment,
  not an improvement, until such a comparison exists.
"""

from __future__ import annotations

import hashlib
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

PROJECT_ROOT = Path(__file__).resolve().parents[2]
PRODUCTION_CHECKPOINTS = [PROJECT_ROOT / "ml" / "checkpoints" / "unet_oil_spill_best.pth"]
CANDIDATES_ROOT = PROJECT_ROOT / "ml" / "checkpoints" / "candidates"


class ProductionCheckpointProtectedError(RuntimeError):
    """Raised when a training run tries to write to a protected checkpoint."""


def sha256_file(path: os.PathLike, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(chunk), b""):
            h.update(block)
    return h.hexdigest()


def _real(p: os.PathLike) -> Path:
    return Path(os.path.realpath(os.path.abspath(os.fspath(p))))


def assert_not_production(path: os.PathLike) -> Path:
    """Raise if `path` resolves to (or is the same file as) a protected checkpoint."""
    target = _real(path)
    for prod in PRODUCTION_CHECKPOINTS:
        prod_real = _real(prod)
        same = target == prod_real
        if not same and target.exists() and prod_real.exists():
            try:
                same = os.path.samefile(target, prod_real)
            except OSError:
                same = False
        if same:
            raise ProductionCheckpointProtectedError(
                f"Refusing to write to the protected production checkpoint {prod_real}. "
                f"Training output must go to {CANDIDATES_ROOT}/<run>/."
            )
    return target


def assert_safe_candidate_output(path: os.PathLike) -> Path:
    """A training output file must be inside CANDIDATES_ROOT, new, and not production."""
    target = assert_not_production(path)
    root = _real(CANDIDATES_ROOT)
    if root != target and root not in target.parents:
        raise ProductionCheckpointProtectedError(
            f"Refusing to write {target}: training outputs must be inside {root}."
        )
    if target.exists():
        raise FileExistsError(f"Refusing to overwrite existing file {target}.")
    return target


def new_candidate_run_dir(run_name: Optional[str] = None, create: bool = True) -> Path:
    """Return a new, unique run directory under CANDIDATES_ROOT."""
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", run_name or "run").strip("_") or "run"
    base = CANDIDATES_ROOT / f"{stamp}_{safe}"
    d, k = base, 1
    while d.exists():
        k += 1
        d = Path(f"{base}_{k}")
    assert_not_production(d / "candidate_best.pth")
    if create:
        d.mkdir(parents=True, exist_ok=False)
    return d


def protected_checkpoint_fingerprints() -> List[Dict[str, Any]]:
    out = []
    for p in PRODUCTION_CHECKPOINTS:
        out.append({"path": str(p.relative_to(PROJECT_ROOT)), "exists": p.exists(),
                    "size_bytes": p.stat().st_size if p.exists() else None,
                    "sha256": sha256_file(p) if p.exists() else None})
    return out


# ---------------------------------------------------------------------------
# dataset preflight (structure only: no raster decoding, no torch)
# ---------------------------------------------------------------------------

REQUIRED_CSV_COLUMNS = {"paths", "coordinates", "class"}
CSV_FILES = {"train": "dataframe_train_dataset_256_90.csv", "val": "dataframe_val_dataset_256_90.csv"}


def validate_dataset_layout(root: os.PathLike) -> Dict[str, Any]:
    """
    Check that a dataset root has the layout ml/datasets/dataset.py requires:

        <root>/train/images/*.tif        <root>/train/masks/<same names>
        <root>/train/dataframe_train_dataset_256_90.csv
        <root>/train/dataframe_val_dataset_256_90.csv
        <root>/test/images/*.tif         <root>/test/masks/<same names>

    CSV columns: paths (image path; only the file name is used), coordinates
    ("a,b" = assumed patch centre row,col), class (integer label).

    Also reports train/validation source-scene overlap: patches cut from the
    same scene in both splits inflate validation metrics (spatial leakage).
    """
    import pandas as pd  # local: keeps module import light

    root = Path(root)
    rep: Dict[str, Any] = {"root": str(root), "ok": True, "errors": [], "warnings": [], "splits": {}}

    def err(msg: str):
        rep["ok"] = False
        rep["errors"].append(msg)

    if not root.is_dir():
        err(f"dataset root not found: {root}")
        return rep

    names_by_split: Dict[str, set] = {}
    for split, csv_name in CSV_FILES.items():
        img_dir, msk_dir, csv = root / "train" / "images", root / "train" / "masks", root / "train" / csv_name
        info: Dict[str, Any] = {"csv": str(csv)}
        rep["splits"][split] = info
        for d in (img_dir, msk_dir):
            if not d.is_dir():
                err(f"[{split}] missing directory {d}")
        if not csv.is_file():
            err(f"[{split}] missing CSV {csv}")
            continue
        info["csv_sha256"] = sha256_file(csv)
        df = pd.read_csv(csv)
        missing_cols = REQUIRED_CSV_COLUMNS - set(df.columns)
        if missing_cols:
            err(f"[{split}] CSV missing columns {sorted(missing_cols)}")
            continue
        names = [Path(str(p).replace("\\", "/")).name for p in df["paths"]]
        names_by_split[split] = set(names)
        info["rows"] = int(len(df))
        info["unique_source_images"] = len(set(names))
        info["class_counts"] = {str(k): int(v) for k, v in df["class"].value_counts().sort_index().items()}
        bad_coords = 0
        for c in df["coordinates"].astype(str):
            try:
                a, b = c.split(",")
                float(a), float(b)
            except Exception:
                bad_coords += 1
        info["invalid_coordinates"] = bad_coords
        if bad_coords:
            err(f"[{split}] {bad_coords} rows with invalid coordinates")
        missing_img = [n for n in set(names) if not (img_dir / n).is_file()]
        missing_msk = [n for n in set(names) if not (msk_dir / n).is_file()]
        info["missing_images"] = len(missing_img)
        info["missing_masks"] = len(missing_msk)
        if missing_img or missing_msk:
            err(f"[{split}] {len(missing_img)} images / {len(missing_msk)} masks referenced by the CSV are missing")

    if "train" in names_by_split and "val" in names_by_split:
        overlap = names_by_split["train"] & names_by_split["val"]
        rep["train_val_shared_source_images"] = len(overlap)
        if overlap:
            rep["warnings"].append(
                f"{len(overlap)} source images contribute patches to BOTH train and validation: "
                "validation metrics are optimistic (spatial leakage). The held-out test scenes are the "
                "only unbiased benchmark."
            )

    t_img, t_msk = root / "test" / "images", root / "test" / "masks"
    tests = sorted(p.name for p in t_img.glob("*.tif")) if t_img.is_dir() else []
    rep["splits"]["test"] = {"scenes": len(tests), "missing_masks": sum(1 for n in tests if not (t_msk / n).is_file())}
    if not tests:
        err(f"[test] no .tif scenes in {t_img}")
    elif rep["splits"]["test"]["missing_masks"]:
        err(f"[test] {rep['splits']['test']['missing_masks']} test scenes have no mask")
    return rep
