#!/usr/bin/env python3
"""
Real SAR Inference Pipeline: High-Resolution Sentinel-1 Acquisition → U-Net Inference
Location: Singapore Strait, vessel activity detection area
Product: Sentinel-1A IW GRD VV (2026-08-26)
Workflow: Process API → Sigma0 dB FLOAT32 → Tiled U-Net → Probability & Mask → Visualization
"""

import sys
import os
import json
import numpy as np
import rasterio
from pathlib import Path
import torch
from tqdm import tqdm
import requests
from datetime import datetime

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from ml.models.unet import SAROilSpillUNet

# ============================================================================
# CONFIGURATION
# ============================================================================

EVENT_ID = "real_S1A_SingaporeStrait_20260826"
EVENT_CENTER = (2.55, 105.57)  # (lat, lon) Singapore Strait oil tanker location
BBOX = {
    "west": 105.50,     # ~7.7 km west of event center (at ~1.5° lat)
    "south": 2.40,      # ~16.6 km south of event center
    "east": 105.64,     # ~7.7 km east of event center
    "north": 2.70,      # ~16.6 km north of event center
}

DATA_DIR = Path(__file__).parent.parent.parent / "data" / "sentinel1"
CHECKPOINT_PATH = Path(__file__).parent.parent / "checkpoints" / "unet_oil_spill_best.pth"
OUTPUT_DIR = DATA_DIR

# Files
SIGMA0_FILE = OUTPUT_DIR / f"{EVENT_ID}_sigma0_10m.tif"
PROBABILITY_FILE = OUTPUT_DIR / f"{EVENT_ID}_oil_probability.tif"
MASK_FILE = OUTPUT_DIR / f"{EVENT_ID}_oil_mask.tif"
VISUALIZATION_DIR = OUTPUT_DIR

# Model config
PATCH_SIZE = 256
OVERLAP = 0  # No overlap for inference
PROBABILITY_THRESHOLD = 0.5

# ============================================================================
# STEP 1: Acquire High-Resolution Sentinel-1 Scene via Copernicus Process API
# ============================================================================

def acquire_sentinel1_scene() -> bool:
    """Request high-resolution event-focused Sentinel-1 scene from Copernicus Process API."""
    print("\n" + "="*70)
    print("[STEP 1] Acquire High-Resolution Sentinel-1 Scene")
    print("="*70)
    
    # Check for existing Sigma0 file
    if SIGMA0_FILE.exists():
        size_mb = SIGMA0_FILE.stat().st_size / (1024**2)
        print(f"✓ Sigma0 file already exists: {SIGMA0_FILE.name} ({size_mb:.1f} MB)")
        return True
    
    # Read token from file
    token_file = Path("/tmp/copernicus_token.txt")
    if not token_file.exists():
        print(f"✗ Token file not found: {token_file}")
        print("  Re-authenticate with Copernicus...")
        return False
    
    with open(token_file) as f:
        access_token = f.read().strip()
    
    print(f"✓ Access token loaded ({len(access_token)} chars)")
    
    # Copernicus Process API request
    process_url = "https://sh.dataspace.copernicus.eu/process/v1/evaluate"
    
    # Evalscript: VV polarization → Sigma0 dB FLOAT32
    evalscript = """
    //VERSION=3
    
    function setup() {
      return {
        input: ["VV", "dataMask"],
        output: {
          bands: 1,
          sampleType: "FLOAT32"
        }
      };
    }
    
    function evaluatePixel(sample, scenes, inputMetadata, customData, outputMetadata) {
      // Convert linear backscatter to dB: 10 * log10(VV)
      let vv_db = 10.0 * Math.log10(Math.max(sample.VV, 1e-6));
      return [vv_db];
    }
    """
    
    # Request payload
    payload = {
        "input": {
            "bounds": {
                "bbox": [BBOX["west"], BBOX["south"], BBOX["east"], BBOX["north"]],
                "properties": {"crs": "http://www.opengis.net/gml/srs/epsg.xml#4326"}
            },
            "data": [
                {
                    "type": "sentinel-1-grd",
                    "dataFilter": {
                        "timeRange": {
                            "from": "2026-08-26T00:00:00Z",
                            "to": "2026-08-27T00:00:00Z"
                        },
                        "resolution": 10,  # Native 10m resolution
                        "polarization": ["VV"]
                    }
                }
            ]
        },
        "output": {
            "width": 512,
            "height": 512,
            "responses": [
                {
                    "identifier": "default",
                    "format": {
                        "type": "image/tiff"
                    }
                }
            ]
        },
        "evalscript": evalscript
    }
    
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json"
    }
    
    print(f"\n[PROCESS API]")
    print(f"  Endpoint: {process_url}")
    print(f"  BBox: W={BBOX['west']} S={BBOX['south']} E={BBOX['east']} N={BBOX['north']}")
    print(f"  Output: 512×512 @ 10m resolution")
    print(f"  Scene date: 2025-07-04")
    print(f"  Polarization: VV")
    print(f"  Requesting...")
    
    try:
        response = requests.post(process_url, json=payload, headers=headers, timeout=60)
        
        print(f"  Response: HTTP {response.status_code}")
        
        if response.status_code == 200:
            # Save TIFF directly
            with open(SIGMA0_FILE, 'wb') as f:
                f.write(response.content)
            
            print(f"✓ Sigma0 scene saved: {SIGMA0_FILE.name}")
            
            # Validate
            try:
                with rasterio.open(SIGMA0_FILE) as src:
                    print(f"  Dimensions: {src.width}×{src.height}")
                    print(f"  CRS: {src.crs}")
                    data = src.read(1)
                    print(f"  Data type: {data.dtype}")
                    valid = np.isfinite(data)
                    if valid.any():
                        stats = data[valid]
                        print(f"  Sigma0 dB range: [{stats.min():.2f}, {stats.max():.2f}]")
                        print(f"  Sigma0 dB mean: {stats.mean():.2f}, std: {stats.std():.2f}")
                        print(f"  Valid pixels: {valid.sum()} / {data.size}")
                    return True
            except Exception as e:
                print(f"✗ Validation error: {e}")
                return False
        else:
            print(f"✗ Process API error: {response.status_code}")
            print(f"  Response: {response.text[:500]}")
            return False
    
    except Exception as e:
        print(f"✗ Request failed: {e}")
        return False

# ============================================================================
# STEP 2: Load U-Net Model
# ============================================================================

def load_model() -> torch.nn.Module:
    """Load trained U-Net model from checkpoint."""
    print("\n" + "="*70)
    print("[STEP 2] Load U-Net Model")
    print("="*70)
    
    # Device
    if torch.backends.mps.is_available() and torch.backends.mps.is_built():
        device = torch.device("mps")
    elif torch.cuda.is_available():
        device = torch.device("cuda")
    else:
        device = torch.device("cpu")
    
    print(f"✓ Device: {device}")
    
    # Load model
    model = SAROilSpillUNet(in_channels=1, num_classes=1)
    checkpoint = torch.load(CHECKPOINT_PATH, map_location="cpu")
    
    if "model_state_dict" in checkpoint:
        model.load_state_dict(checkpoint["model_state_dict"])
    else:
        model.load_state_dict(checkpoint)
    
    model.to(device)
    model.eval()
    
    print(f"✓ Checkpoint loaded: {CHECKPOINT_PATH.name}")
    print(f"  Model: SAROilSpillUNet(in=1, out=1)")
    
    return model, device

# ============================================================================
# STEP 3: Tiled U-Net Inference with Dataset Normalization
# ============================================================================

def run_tiled_inference(model: torch.nn.Module, device: torch.device) -> np.ndarray:
    """Execute tiled U-Net inference with per-image normalization."""
    print("\n" + "="*70)
    print("[STEP 3] Tiled U-Net Inference")
    print("="*70)
    
    # Load Sigma0 data
    with rasterio.open(SIGMA0_FILE) as src:
        sigma0 = src.read(1).astype(np.float32)
        profile = src.profile
    
    print(f"✓ Sigma0 loaded: {sigma0.shape}")
    print(f"  Data range: [{np.nanmin(sigma0):.2f}, {np.nanmax(sigma0):.2f}]")
    
    # CRITICAL: Apply per-image normalization (Dataset 2 scheme from dataset.py)
    print(f"\n[NORMALIZATION] Per-image statistics")
    
    valid = np.isfinite(sigma0)
    if valid.any():
        values = sigma0[valid]
        mean = values.mean()
        std = values.std()
        print(f"  Mean (finite): {mean:.4f}")
        print(f"  Std (finite): {std:.4f}")
        
        sigma0_norm = (sigma0 - mean) / (std + 1e-6)
        
        # Clean invalid values
        sigma0_norm = np.nan_to_num(sigma0_norm, nan=0.0, posinf=0.0, neginf=0.0)
        
        print(f"  Normalized range: [{sigma0_norm.min():.4f}, {sigma0_norm.max():.4f}]")
    else:
        print(f"  ✗ No finite values found!")
        sigma0_norm = np.zeros_like(sigma0)
    
    # Tiled inference
    height, width = sigma0_norm.shape
    
    # Calculate number of tiles
    if OVERLAP > 0:
        stride = PATCH_SIZE - OVERLAP
    else:
        stride = PATCH_SIZE
    
    # Create output array
    probability = np.zeros((height, width), dtype=np.float32)
    
    print(f"\n[INFERENCE]")
    print(f"  Patch size: {PATCH_SIZE}×{PATCH_SIZE}")
    print(f"  Stride: {stride}")
    
    # Calculate tile positions
    tiles = []
    for y in range(0, height, stride):
        for x in range(0, width, stride):
            y_end = min(y + PATCH_SIZE, height)
            x_end = min(x + PATCH_SIZE, width)
            tiles.append((y, x, y_end, x_end))
    
    print(f"  Total tiles: {len(tiles)}")
    
    # Process tiles
    with torch.no_grad():
        for tile_idx, (y, x, y_end, x_end) in enumerate(tqdm(tiles, desc="Processing tiles")):
            # Extract patch
            patch = sigma0_norm[y:y_end, x:x_end]
            
            # Pad if necessary
            if patch.shape != (PATCH_SIZE, PATCH_SIZE):
                patch_padded = np.zeros((PATCH_SIZE, PATCH_SIZE), dtype=np.float32)
                patch_padded[:patch.shape[0], :patch.shape[1]] = patch
                patch = patch_padded
            
            # Convert to tensor
            patch_tensor = torch.from_numpy(patch).unsqueeze(0).unsqueeze(0).to(device)
            
            # Forward pass
            with torch.no_grad():
                output = model(patch_tensor)
            
            # Convert to numpy and apply sigmoid if not already done
            pred = output.squeeze().cpu().numpy().astype(np.float32)
            
            # Handle output size mismatch
            if pred.shape != (PATCH_SIZE, PATCH_SIZE):
                # Resize if needed
                from scipy.ndimage import zoom
                zoom_factor = PATCH_SIZE / pred.shape[0]
                pred = zoom(pred, zoom_factor)
            
            # Place in output
            pred_cropped = pred[:y_end-y, :x_end-x]
            probability[y:y_end, x:x_end] = pred_cropped
    
    print(f"✓ Inference complete")
    print(f"  Probability range: [{probability.min():.6f}, {probability.max():.6f}]")
    print(f"  Probability mean: {probability.mean():.6f}")
    print(f"  Probability std: {probability.std():.6f}")
    
    return probability, profile

# ============================================================================
# STEP 4: Save Probability and Binary Mask
# ============================================================================

def save_probability_and_mask(probability: np.ndarray, profile: dict):
    """Save probability map and binary mask."""
    print("\n" + "="*70)
    print("[STEP 4] Save Probability and Binary Mask")
    print("="*70)
    
    # Update profile
    profile.update(dtype=rasterio.float32, count=1)
    
    # Save probability
    with rasterio.open(PROBABILITY_FILE, 'w', **profile) as dst:
        dst.write(probability, 1)
    
    print(f"✓ Probability map saved: {PROBABILITY_FILE.name}")
    
    # Create and save binary mask
    mask = (probability > PROBABILITY_THRESHOLD).astype(np.float32)
    
    with rasterio.open(MASK_FILE, 'w', **profile) as dst:
        dst.write(mask, 1)
    
    # Statistics
    pixel_counts = {
        "total": mask.size,
        "positive": int((mask > 0).sum()),
        "negative": int((mask == 0).sum()),
        "pct_positive": 100.0 * (mask > 0).sum() / mask.size,
    }
    
    print(f"✓ Binary mask saved: {MASK_FILE.name}")
    print(f"  Positive pixels (threshold={PROBABILITY_THRESHOLD}): {pixel_counts['positive']} ({pixel_counts['pct_positive']:.2f}%)")
    
    # Additional thresholds for analysis
    print(f"\n[PROBABILITY ANALYSIS]")
    for thresh in [0.3, 0.5, 0.7, 0.9]:
        count = ((probability > thresh).sum())
        pct = 100.0 * count / probability.size
        print(f"  Pixels > {thresh}: {count} ({pct:.3f}%)")
    
    return pixel_counts

# ============================================================================
# STEP 5: Visualization
# ============================================================================

def visualize_results(sigma0: np.ndarray, probability: np.ndarray):
    """Generate publication-ready visualizations."""
    print("\n" + "="*70)
    print("[STEP 5] Visualization")
    print("="*70)
    
    import matplotlib.pyplot as plt
    import matplotlib.patches as mpatches
    
    # Load original for sigma0
    with rasterio.open(SIGMA0_FILE) as src:
        sigma0_data = src.read(1)
    
    # Create figure with 3 subplots
    fig, axes = plt.subplots(1, 3, figsize=(18, 5))
    fig.suptitle(f"Real Sentinel-1 Event Inference: {EVENT_ID}", fontsize=14, fontweight="bold")
    
    # Subplot 1: Sigma0 dB
    ax = axes[0]
    valid = np.isfinite(sigma0_data)
    vmin, vmax = np.nanmin(sigma0_data), np.nanmax(sigma0_data)
    im1 = ax.imshow(sigma0_data, cmap='gray_r', vmin=vmin, vmax=vmax)
    ax.set_title("Sigma0 dB (VV polarization)")
    ax.set_xlabel("X (pixels)")
    ax.set_ylabel("Y (pixels)")
    plt.colorbar(im1, ax=ax, label="dB")
    
    # Add stats box
    stats_text = f"Min: {np.nanmin(sigma0_data):.1f} dB\nMax: {np.nanmax(sigma0_data):.1f} dB\nMean: {np.nanmean(sigma0_data):.1f} dB"
    ax.text(0.98, 0.02, stats_text, transform=ax.transAxes, 
            fontsize=9, verticalalignment='bottom', horizontalalignment='right',
            bbox=dict(boxstyle='round', facecolor='wheat', alpha=0.8))
    
    # Subplot 2: Probability map
    ax = axes[1]
    im2 = ax.imshow(probability, cmap='hot', vmin=0, vmax=1)
    ax.set_title("U-Net Probability (Oil Spill)")
    ax.set_xlabel("X (pixels)")
    ax.set_ylabel("Y (pixels)")
    plt.colorbar(im2, ax=ax, label="Probability")
    
    # Subplot 3: Overlay (Sigma0 + probability contours)
    ax = axes[2]
    ax.imshow(sigma0_data, cmap='gray_r', vmin=vmin, vmax=vmax, alpha=0.7)
    contour = ax.contourf(probability, levels=[PROBABILITY_THRESHOLD, 1.0], colors=['red'], alpha=0.4)
    ax.contour(probability, levels=[PROBABILITY_THRESHOLD], colors=['red'], linewidths=2)
    ax.set_title(f"Overlay (Threshold={PROBABILITY_THRESHOLD})")
    ax.set_xlabel("X (pixels)")
    ax.set_ylabel("Y (pixels)")
    
    # Legend for overlay
    red_patch = mpatches.Patch(color='red', alpha=0.4, label=f'Detection (>{PROBABILITY_THRESHOLD})')
    ax.legend(handles=[red_patch], loc='upper right')
    
    plt.tight_layout()
    
    # Save figure
    viz_file = VISUALIZATION_DIR / f"{EVENT_ID}_results.png"
    plt.savefig(viz_file, dpi=100, bbox_inches='tight')
    print(f"✓ Visualization saved: {viz_file.name}")
    
    plt.close()

# ============================================================================
# MAIN
# ============================================================================

def main():
    """Execute full event inference pipeline."""
    print("\n" + "="*70)
    print("REAL SAR INFERENCE PIPELINE")
    print(f"Location: Singapore Strait (vessel activity area)")
    print(f"Coordinates: {EVENT_CENTER[0]}°N, {EVENT_CENTER[1]}°E")
    print(f"Product: Sentinel-1A IW GRD VV (2026-08-26)")
    print(f"Start time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("="*70)
    
    # Ensure output directory exists
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    
    try:
        # Step 1: Acquire high-res scene
        if not acquire_sentinel1_scene():
            print("✗ Failed to acquire Sentinel-1 scene")
            return False
        
        # Step 2: Load model
        model, device = load_model()
        
        # Step 3: Run inference
        probability, profile = run_tiled_inference(model, device)
        
        # Step 4: Save outputs
        pixel_counts = save_probability_and_mask(probability, profile)
        
        # Step 5: Visualize
        with rasterio.open(SIGMA0_FILE) as src:
            sigma0_data = src.read(1)
        visualize_results(sigma0_data, probability)
        
        # Final summary
        print("\n" + "="*70)
        print("PIPELINE COMPLETE")
        print("="*70)
        print(f"\nOutput Files:")
        print(f"  Sigma0: {SIGMA0_FILE.name}")
        print(f"  Probability: {PROBABILITY_FILE.name}")
        print(f"  Binary Mask: {MASK_FILE.name}")
        print(f"  Visualization: {VISUALIZATION_DIR / f'{EVENT_ID}_results.png'}")
        
        print(f"\nDETECTION SUMMARY:")
        if pixel_counts['positive'] > 0:
            print(f"  ✓ DETECTION FOUND: {pixel_counts['positive']} positive pixels ({pixel_counts['pct_positive']:.2f}%)")
        else:
            print(f"  ✗ NO DETECTION: 0 pixels above {PROBABILITY_THRESHOLD} threshold")
        
        print(f"\nEnd time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        
        return True
        
    except Exception as e:
        print(f"\n✗ Pipeline failed: {e}")
        import traceback
        traceback.print_exc()
        return False

if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1)
