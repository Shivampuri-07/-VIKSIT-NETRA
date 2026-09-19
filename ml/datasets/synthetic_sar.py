"""
Synthetic SAR Sea Surface and Oil Spill Generator.
Generates realistic SAR backscatter rasters with:
- Ocean background sea clutter
- Capillary wave damping in oil slick regions
- Multiplicative speckle noise (Sentinel-1 C-SAR characteristic)
- Ground-truth binary segmentation masks
- Georeferenced WGS84 bounding box metadata
"""

import math
import random
from typing import Tuple, Dict, Any, List, Union

try:
    import numpy as np
    HAS_NUMPY = True
except ImportError:
    HAS_NUMPY = False


def generate_synthetic_sar_scene(
    width: int = 512,
    height: int = 512,
    spill_count: int = 1,
    seed: int = 42,
    bbox: Tuple[float, float, float, float] = (-88.65, 28.50, -88.15, 28.95)
) -> Tuple[Any, Any, Dict[str, Any]]:
    """
    Generates a realistic synthetic Sentinel-1 GRD SAR amplitude patch.
    """
    min_lon, min_lat, max_lon, max_lat = bbox
    pixel_size_x = (max_lon - min_lon) / width
    pixel_size_y = (max_lat - min_lat) / height

    metadata = {
        "dataset_type": "DEMO_SYNTHETIC_SAR",
        "sensor": "Sentinel-1 C-SAR GRD (Simulated C-Band)",
        "polarization": "VV",
        "bbox": list(bbox),
        "width": width,
        "height": height,
        "pixel_size_deg": (pixel_size_x, pixel_size_y),
        "acquisition_time": "2026-08-28T06:14:22Z",
        "center_coords": [(min_lat + max_lat) / 2.0, (min_lon + max_lon) / 2.0],
        "disclaimer": "DEMO MODE: Synthetic SAR backscatter generated for pipeline testing. Replace with Copernicus Data Space S1 GRD GeoTIFF for real research."
    }

    if HAS_NUMPY:
        rng = np.random.default_rng(seed)
        sea_clutter = rng.gamma(shape=4.0, scale=0.15, size=(height, width)).astype(np.float32)
        y, x = np.mgrid[0:height, 0:width]
        wave_pattern = 0.15 * np.sin(x * 0.05 + y * 0.03) + 0.10 * np.cos(x * 0.02 - y * 0.04)
        background = sea_clutter + wave_pattern

        mask = np.zeros((height, width), dtype=np.uint8)
        slick_attenuation = np.zeros((height, width), dtype=np.float32)

        for s_idx in range(spill_count):
            cx = int(width * 0.52 + rng.uniform(-40, 40))
            cy = int(height * 0.48 + rng.uniform(-40, 40))
            angle = np.radians(35.0 + rng.uniform(-10, 10))
            cos_a, sin_a = np.cos(angle), np.sin(angle)

            dx = (x - cx) * cos_a + (y - cy) * sin_a
            dy = -(x - cx) * sin_a + (y - cy) * cos_a

            length_scale = 140.0
            width_scale = 22.0
            curvature = 0.003 * dx**2
            dist_sq = (dx / length_scale)**2 + ((dy - curvature) / width_scale)**2

            slick_core = (dist_sq <= 1.0).astype(np.uint8)
            mask = np.maximum(mask, slick_core)
            attenuation_factor = np.exp(-0.5 * dist_sq)
            slick_attenuation = np.maximum(slick_attenuation, attenuation_factor * 0.75)

        sar_intensity = background * (1.0 - slick_attenuation)
        speckle = rng.rayleigh(scale=0.8, size=(height, width)).astype(np.float32)
        sar_noisy = sar_intensity * (0.7 + 0.3 * speckle)
        sar_normalized = np.clip(sar_noisy / (np.percentile(sar_noisy, 99.5) + 1e-5), 0.0, 1.0)
        return sar_normalized, mask, metadata

    # Pure Python fallback
    rnd = random.Random(seed)
    sar_grid = []
    mask_grid = []
    cx = width * 0.52
    cy = height * 0.48

    for r in range(height):
        sar_row = []
        mask_row = []
        for c in range(width):
            dx = c - cx
            dy = r - cy
            # Rotate 35 deg
            cos_a, sin_a = math.cos(0.61), math.sin(0.61)
            rx = dx * cos_a + dy * sin_a
            ry = -dx * sin_a + dy * cos_a
            dist_sq = (rx / 70.0)**2 + (ry / 15.0)**2

            is_slick = 1 if dist_sq <= 1.0 else 0
            atten = math.exp(-0.5 * dist_sq) * 0.75 if dist_sq < 4.0 else 0.0
            
            # Base intensity + speckle
            noise = rnd.gauss(0.6, 0.15)
            val = max(0.0, min(1.0, (0.7 - atten) * noise))
            
            sar_row.append(val)
            mask_row.append(is_slick)
        sar_grid.append(sar_row)
        mask_grid.append(mask_row)

    return sar_grid, mask_grid, metadata
