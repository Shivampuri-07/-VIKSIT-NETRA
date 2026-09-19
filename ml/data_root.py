"""
Configurable external data root for the AEGIS project.

The large original data (labelled Radar_data, the real 2018-09-26 SAR scene, ERA5, AIS) is NOT
copied into this repository. It is read from an external directory given by

    AEGIS_DATA_ROOT=/path/to/AEGIS-Sentinel-Oil-Spill-main 3

resolved in this order: process environment, then a line ``AEGIS_DATA_ROOT=...`` in the project
``.env`` (ONLY that key is read from .env; no other value is parsed or exposed). Nothing here
hard-codes a user name or a machine path. When it is unset, everything falls back to the
repository-local ``data/`` and ``ml/datasets`` directories.

    from ml.data_root import data_root, resolve_data, radar_dataset_root
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

PROJECT_ROOT = Path(__file__).resolve().parents[1]
RADAR_REL = Path("ml") / "datasets" / "radar_data" / "Radar_data"


def _from_dotenv(key: str) -> Optional[str]:
    env_file = PROJECT_ROOT / ".env"
    try:
        for line in env_file.read_text(encoding="utf-8").splitlines():
            s = line.strip()
            if not s or s.startswith("#") or "=" not in s:
                continue
            k, v = s.split("=", 1)
            if k.strip() == key:
                v = v.strip()
                if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                    v = v[1:-1]
                return v or None
    except OSError:
        pass
    return None


def data_root() -> Optional[Path]:
    """The external data root if configured AND present, else None."""
    raw = os.environ.get("AEGIS_DATA_ROOT") or _from_dotenv("AEGIS_DATA_ROOT")
    if not raw:
        return None
    p = Path(os.path.expanduser(raw))
    return p if p.is_dir() else None


def resolve_data(*parts: str) -> Optional[Path]:
    """
    First existing path among: <AEGIS_DATA_ROOT>/<parts>, <AEGIS_DATA_ROOT>/<parts with Data/data case
    swapped> (the original tree uses ``Data/``; some checkouts use ``data/``), <PROJECT>/<parts>.
    """
    rel = Path(*parts)
    cands = []
    root = data_root()
    if root is not None:
        cands.append(root / rel)
        first = rel.parts[0] if rel.parts else ""
        if first in ("data", "Data"):
            swapped = ("Data" if first == "data" else "data",) + rel.parts[1:]
            cands.append(root / Path(*swapped))
    cands.append(PROJECT_ROOT / rel)
    for c in cands:
        if c.exists():
            return c
    return None


def radar_dataset_root() -> Path:
    """Labelled Radar_data root (train/test images+masks, train/val CSVs): external first, then local."""
    root = data_root()
    if root is not None and (root / RADAR_REL).is_dir():
        return root / RADAR_REL
    return PROJECT_ROOT / RADAR_REL
