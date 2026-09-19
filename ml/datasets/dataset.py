"""
Real Sentinel-1 Oil Spill Segmentation Dataset Loader

Dataset:
Oil Spill Segmentation - Zenodo 10.5281/zenodo.4672426

Structure:
Radar_data/
├── train/
│   ├── images/
│   ├── masks/
│   ├── dataframe_train_dataset_256_90.csv
│   └── dataframe_val_dataset_256_90.csv
└── test/
    ├── images/
    └── masks/
"""

import os
from pathlib import Path
from typing import Dict, Tuple, Optional

import numpy as np
import pandas as pd
import rasterio
import torch
from torch.utils.data import Dataset


# Performance only: __getitem__ used to re-read the WHOLE scene raster + mask from disk for every 256 px
# patch (hours per epoch on the real dataset). Scenes are now decoded once per process and reused.
# The returned arrays are bit-identical to a fresh read (keyed by path + mtime + size, read-only views).
_TIF_CACHE: Dict[tuple, np.ndarray] = {}
_STATS_CACHE: Dict[tuple, Optional[Tuple[np.float32, np.float32]]] = {}
_CACHE_ENABLED = os.environ.get("AEGIS_DATASET_CACHE", "1") != "0"


def _cache_key(path) -> Optional[tuple]:
    try:
        st = os.stat(str(path))
        return (str(path), st.st_mtime_ns, st.st_size)
    except OSError:
        return None


class SAROilSpillDataset(Dataset):
    """
    Loads real Sentinel-1 SAR image patches and corresponding
    binary oil-spill mask patches using the dataset CSV.
    """

    def __init__(
        self,
        root_dir: str,
        split: str = "train",
        normalize: bool = True,
        normalization: str = "patch",
    ):
        self.root_dir = Path(root_dir)
        self.split = split
        self.normalize = normalize
        # "patch": z-score each extracted 256 px patch (original training behaviour)
        # "scene": z-score the whole scene first, then extract (matches test_model.py /
        #          real_scene_inference.py); lets a candidate be trained with the
        #          preprocessing it will be evaluated with.
        if normalization not in ("patch", "scene"):
            raise ValueError("normalization must be 'patch' or 'scene'")
        self.normalization = normalization

        if split == "train":
            self.csv_path = (
                self.root_dir
                / "train"
                / "dataframe_train_dataset_256_90.csv"
            )
            self.image_dir = self.root_dir / "train" / "images"
            self.mask_dir = self.root_dir / "train" / "masks"

        elif split == "val":
            self.csv_path = (
                self.root_dir
                / "train"
                / "dataframe_val_dataset_256_90.csv"
            )
            self.image_dir = self.root_dir / "train" / "images"
            self.mask_dir = self.root_dir / "train" / "masks"

        elif split == "test":
            self.csv_path = None
            self.image_dir = self.root_dir / "test" / "images"
            self.mask_dir = self.root_dir / "test" / "masks"

        else:
            raise ValueError("split must be 'train', 'val', or 'test'")

        if not self.image_dir.exists():
            raise FileNotFoundError(
                f"Image directory not found: {self.image_dir}"
            )

        if not self.mask_dir.exists():
            raise FileNotFoundError(
                f"Mask directory not found: {self.mask_dir}"
            )

        # CSV-based patch dataset for train/validation
        if self.csv_path is not None:
            if not self.csv_path.exists():
                raise FileNotFoundError(
                    f"CSV not found: {self.csv_path}"
                )

            self.df = pd.read_csv(self.csv_path)

            required_columns = {"paths", "coordinates", "class"}
            missing = required_columns - set(self.df.columns)

            if missing:
                raise ValueError(
                    f"CSV is missing columns: {missing}"
                )

            self.samples = self._build_csv_samples()

        # Test split: use complete image/mask scenes.
        else:
            self.samples = self._build_test_samples()

        if len(self.samples) == 0:
            raise RuntimeError(
                f"No samples found for split='{split}'"
            )

        print(
            f"[Dataset] split={split} | "
            f"samples={len(self.samples)}"
        )

    def _build_csv_samples(self):
        """
        Convert CSV rows into:
        (image_path, mask_path, x, y, class_label)
        """

        samples = []

        for _, row in self.df.iterrows():

            # Original CSV stores Windows-style paths.
            csv_path = str(row["paths"]).replace("\\", "/")

            filename = Path(csv_path).name

            image_path = self.image_dir / filename
            mask_path = self.mask_dir / filename

            if not image_path.exists():
                raise FileNotFoundError(
                    f"Image referenced by CSV not found:\n{image_path}"
                )

            if not mask_path.exists():
                raise FileNotFoundError(
                    f"Mask referenced by CSV not found:\n{mask_path}"
                )

            # coordinates are stored as "x,y" / "y,x".
            # We preserve the CSV values here and validate them
            # against the raster dimensions when loading.
            coord = str(row["coordinates"]).strip()

            try:
                a, b = coord.split(",")
                a = int(float(a))
                b = int(float(b))
            except Exception as exc:
                raise ValueError(
                    f"Invalid coordinates: {coord}"
                ) from exc

            label = int(float(row["class"]))

            samples.append(
                {
                    "image": image_path,
                    "mask": mask_path,
                    "coord_a": a,
                    "coord_b": b,
                    "label": label,
                }
            )

        return samples

    def _build_test_samples(self):
        """
        Test split contains complete Sentinel-1 scenes.
        """

        samples = []

        image_files = sorted(
            self.image_dir.glob("*.tif")
        )

        for image_path in image_files:

            mask_path = self.mask_dir / image_path.name

            if not mask_path.exists():
                raise FileNotFoundError(
                    f"Matching mask not found for {image_path.name}"
                )

            samples.append(
                {
                    "image": image_path,
                    "mask": mask_path,
                    "coord_a": None,
                    "coord_b": None,
                    "label": None,
                }
            )

        return samples

    @staticmethod
    def _read_tif(path) -> np.ndarray:
        """
        Read band 1 of a raster as float32.

        Mirrors ml/inference/test_model.py (``src.read(1)``), which produced
        the recorded baseline test metrics, so training and evaluation read
        rasters identically. The raster's nodata value is NOT masked here
        (same as test_model.py); non-finite values are zeroed after
        normalisation in __getitem__.
        """
        key = _cache_key(path) if _CACHE_ENABLED else None
        if key is not None and key in _TIF_CACHE:
            return _TIF_CACHE[key]
        with rasterio.open(path) as src:
            arr = src.read(1).astype(np.float32)
        if key is not None:
            arr.setflags(write=False)
            _TIF_CACHE[key] = arr
        return arr

    @staticmethod
    def _scene_stats(path, image: np.ndarray):
        """(mean, std) over the finite pixels of a whole scene, or None if there are none (cached)."""
        key = _cache_key(path) if _CACHE_ENABLED else None
        if key is not None and key in _STATS_CACHE:
            return _STATS_CACHE[key]
        valid = np.isfinite(image)
        stats = None
        if valid.any():
            values = image[valid]
            stats = (values.mean(), values.std())
        if key is not None:
            _STATS_CACHE[key] = stats
        return stats

    @staticmethod
    def _extract_patch(
        image: np.ndarray,
        mask: np.ndarray,
        a: int,
        b: int,
        patch_size: int = 256,
    ):
        """
        Extract a patch_size x patch_size patch using the CSV coordinates.

        ASSUMPTION (not verifiable from the repository, the dataset is not
        bundled): the CSV "coordinates" value is the patch CENTRE given as
        (row, column), i.e. row = a, col = b. Patches are clamped so they lie
        completely inside the raster.
        """
        if image.shape != mask.shape:
            raise ValueError(
                f"Image/mask shape mismatch: {image.shape} vs {mask.shape}"
            )

        height, width = image.shape

        if height < patch_size or width < patch_size:
            raise ValueError(
                f"Could not extract {patch_size}x{patch_size} patch "
                f"from coordinates ({a}, {b}) "
                f"for image size ({width}, {height})"
            )

        row = int(a)
        col = int(b)
        half = patch_size // 2

        # Convert centre coordinate -> top-left
        y = row - half
        x = col - half

        # Keep patch completely inside raster
        y = max(0, min(y, height - patch_size))
        x = max(0, min(x, width - patch_size))

        image_patch = image[y:y + patch_size, x:x + patch_size]
        mask_patch = mask[y:y + patch_size, x:x + patch_size]

        return image_patch, mask_patch

    @staticmethod
    def _zscore(image: np.ndarray) -> np.ndarray:
        valid = np.isfinite(image)
        if not valid.any():
            return np.zeros_like(image)
        values = image[valid]
        return (image - values.mean()) / (values.std() + 1e-6)

    def __len__(self):
        return len(self.samples)

    def __getitem__(self, idx):

        sample = self.samples[idx]

        image = self._read_tif(sample["image"])
        mask = self._read_tif(sample["mask"])

        scene_stats = None
        scene_norm_on_patch = False
        if self.normalize and self.normalization == "scene":
            if self.split in ("train", "val"):
                # z-scoring the scene and then cropping equals cropping and applying the scene mean/std
                # elementwise (same float32 ops), without normalising ~26 M pixels for every patch.
                scene_stats = self._scene_stats(sample["image"], image)
                scene_norm_on_patch = True
            else:
                image = self._zscore(image)

        if self.split in ("train", "val"):

            image, mask = self._extract_patch(
                image,
                mask,
                sample["coord_a"],
                sample["coord_b"],
                patch_size=256,
            )

        if scene_norm_on_patch:
            if scene_stats is None:
                image = np.zeros_like(image)
            else:
                image = (image - scene_stats[0]) / (scene_stats[1] + 1e-6)

        # Normalize SAR image (per patch; scene-level normalisation was applied above)
        if self.normalize and self.normalization == "patch":
            image = self._zscore(image)

        # Clean invalid values
        image = np.nan_to_num(
            image,
            nan=0.0,
            posinf=0.0,
            neginf=0.0,
        )

        # Binary mask
        mask = (mask > 0.5).astype(np.float32)

        # CHW format
        image = np.expand_dims(image, axis=0)
        mask = np.expand_dims(mask, axis=0)

        image_tensor = torch.from_numpy(image).float()
        mask_tensor = torch.from_numpy(mask).float()

        return image_tensor, mask_tensor