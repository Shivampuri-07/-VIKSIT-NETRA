#!/usr/bin/env python3
"""
Real SAR Inference Pipeline: U-Net on Existing Sentinel-1 Sigma0
Uses: S1A 2025-07-04 Sigma0 VV backscatter data
Workflow: Load real Sigma0 → Tiled U-Net inference → Probability & Mask → Visualization
"""

import sys
import os
import json
import numpy as np
import rasterio
from pathlib import Path
import torch
from tqdm import tqdm
from datetime import datetime
import warnings

warnings.filterwarnings('ignore')

# Add project root
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from ml.models.unet import SAROilSpillUNet

# ============================================================================
# CONFIGURATION
# ============================================================================

# Use the corrected Sigma0 data that was successfully processed
SIGMA0_INPUT = Path(__file__).parent.parent.parent / "data" / "sentinel1" / "S1A_20250704_VV_sigma0_db_correct.tif"

DATA_DIR = Path(__file__).parent.parent.parent / "data" / "sentinel1"
CHECKPOINT_PATH = Path(__file__).parent.parent / "checkpoints" / "unet_oil_spill_best.pth"
OUTPUT_DIR = DATA_DIR

# Output files
EVENT_ID = "S1A_20250704_VV_UNetInference"
PROBABILITY_FILE = OUTPUT_DIR / f"{EVENT_ID}_oil_probability.tif"
MASK_FILE = OUTPUT_DIR / f"{EVENT_ID}_oil_mask.tif"

# Model config
PATCH_SIZE = 256
OVERLAP = 0
PROBABILITY_THRESHOLD = 0.5

# ============================================================================
# UTILITIES
# ============================================================================

def get_device() -> torch.device:
    """Determine best available device."""
    if torch.backends.mps.is_available() and torch.backends.mps.is_built():
        return torch.device("mps")
    elif torch.cuda.is_available():
        return torch.device("cuda")
    else:
        return torch.device("cpu")

def safe_normalize_data(data: np.ndarray, finite_only: bool = True) -> np.ndarray:
    """Normalize data per-image with robust handling of invalid values."""
    if finite_only:
        valid = np.isfinite(data)
        if valid.any():
            values = data[valid]
            mean = values.mean()
            std = values.std()
            normalized = (data - mean) / (std + 1e-6)
        else:
            normalized = np.zeros_like(data)
    else:
        mean = np.nanmean(data)
        std = np.nanstd(data)
        normalized = (data - mean) / (std + 1e-6) if std > 0 else np.zeros_like(data)
    
    # Clean invalid values
    normalized = np.nan_to_num(normalized, nan=0.0, posinf=0.0, neginf=0.0)
    return normalized

# ============================================================================
# STEP 1: Load and Validate Sigma0 Data
# ============================================================================

def load_sigma0_data() -> tuple:
    """Load real Sentinel-1 Sigma0 VV backscatter data."""
    print("\n" + "="*70)
    print("[STEP 1] Load Real Sentinel-1 Sigma0 Data")
    print("="*70)
    
    if not SIGMA0_INPUT.exists():
        print(f"✗ Sigma0 file not found: {SIGMA0_INPUT}")
        return None, None
    
    print(f"✓ Loading: {SIGMA0_INPUT.name}")
    
    with rasterio.open(SIGMA0_INPUT) as src:
        sigma0 = src.read(1).astype(np.float32)
        profile = src.profile
        crs = src.crs
        bounds = src.bounds
    
    print(f"\n[DATA INFO]")
    print(f"  Dimensions: {sigma0.shape[0]}×{sigma0.shape[1]} pixels")
    print(f"  CRS: {crs}")
    print(f"  Bounds: {bounds}")
    print(f"  Data type: {sigma0.dtype}")
    
    # Statistics
    valid = np.isfinite(sigma0)
    print(f"\n[SIGMA0 STATISTICS]")
    print(f"  Valid pixels: {valid.sum()} / {sigma0.size} ({100.0*valid.sum()/sigma0.size:.1f}%)")
    
    if valid.any():
        stats = sigma0[valid]
        print(f"  Sigma0 dB range: [{stats.min():.2f}, {stats.max():.2f}]")
        print(f"  Sigma0 dB mean: {stats.mean():.2f}")
        print(f"  Sigma0 dB std: {stats.std():.2f}")
    else:
        print(f"  ✗ No valid data!")
        return None, None
    
    print(f"\n✓ Data loaded successfully")
    return sigma0, profile

# ============================================================================
# STEP 2: Load U-Net Model
# ============================================================================

def load_model() -> tuple:
    """Load trained U-Net model."""
    print("\n" + "="*70)
    print("[STEP 2] Load U-Net Model")
    print("="*70)
    
    device = get_device()
    print(f"✓ Device: {device}")
    
    if not CHECKPOINT_PATH.exists():
        print(f"✗ Checkpoint not found: {CHECKPOINT_PATH}")
        return None, None
    
    model = SAROilSpillUNet(in_channels=1, num_classes=1)
    checkpoint = torch.load(CHECKPOINT_PATH, map_location="cpu")
    
    if "model_state_dict" in checkpoint:
        model.load_state_dict(checkpoint["model_state_dict"])
    else:
        model.load_state_dict(checkpoint)
    
    model.to(device)
    model.eval()
    
    print(f"✓ Checkpoint loaded: {CHECKPOINT_PATH.name}")
    print(f"  Architecture: SAROilSpillUNet(in=1, out=1)")
    
    # Count parameters
    total_params = sum(p.numel() for p in model.parameters())
    print(f"  Total parameters: {total_params:,}")
    
    return model, device

# ============================================================================
# STEP 3: Tiled U-Net Inference
# ============================================================================

def run_tiled_inference(sigma0: np.ndarray, model: torch.nn.Module, device: torch.device) -> np.ndarray:
    """Execute tiled U-Net inference with per-image normalization."""
    print("\n" + "="*70)
    print("[STEP 3] Tiled U-Net Inference")
    print("="*70)
    
    height, width = sigma0.shape
    
    # Apply per-image normalization (Dataset 2 scheme)
    print(f"\n[NORMALIZATION] Per-image statistics")
    sigma0_norm = safe_normalize_data(sigma0, finite_only=True)
    print(f"  Normalized range: [{sigma0_norm.min():.4f}, {sigma0_norm.max():.4f}]")
    print(f"  Mean: {sigma0_norm.mean():.6f}, Std: {sigma0_norm.std():.6f}")
    
    # Calculate tile positions
    stride = PATCH_SIZE if OVERLAP == 0 else PATCH_SIZE - OVERLAP
    tiles = []
    for y in range(0, height, stride):
        for x in range(0, width, stride):
            y_end = min(y + PATCH_SIZE, height)
            x_end = min(x + PATCH_SIZE, width)
            tiles.append((y, x, y_end, x_end))
    
    # Initialize probability output
    probability = np.zeros((height, width), dtype=np.float32)
    
    print(f"\n[INFERENCE]")
    print(f"  Input shape: {height}×{width}")
    print(f"  Patch size: {PATCH_SIZE}×{PATCH_SIZE}")
    print(f"  Stride: {stride}")
    print(f"  Total tiles: {len(tiles)}")
    
    # Process tiles
    with torch.no_grad():
        for y, x, y_end, x_end in tqdm(tiles, desc="Processing tiles", unit="tile"):
            # Extract and pad patch
            patch = sigma0_norm[y:y_end, x:x_end]
            
            if patch.shape != (PATCH_SIZE, PATCH_SIZE):
                patch_padded = np.zeros((PATCH_SIZE, PATCH_SIZE), dtype=np.float32)
                patch_padded[:patch.shape[0], :patch.shape[1]] = patch
                patch = patch_padded
            
            # Forward pass
            patch_tensor = torch.from_numpy(patch).unsqueeze(0).unsqueeze(0).to(device)
            output = model(patch_tensor)
            pred = output.squeeze().cpu().numpy().astype(np.float32)
            
            # Crop to original tile size
            pred_cropped = pred[:y_end-y, :x_end-x]
            probability[y:y_end, x:x_end] = pred_cropped
    
    print(f"\n✓ Inference complete")
    print(f"  Probability range: [{probability.min():.6f}, {probability.max():.6f}]")
    print(f"  Probability mean: {probability.mean():.6f}")
    print(f"  Probability std: {probability.std():.6f}")
    
    return probability

# ============================================================================
# STEP 4: Save Outputs
# ============================================================================

def save_outputs(probability: np.ndarray, profile: dict) -> dict:
    """Save probability and binary mask."""
    print("\n" + "="*70)
    print("[STEP 4] Save Outputs")
    print("="*70)
    
    profile.update(dtype=rasterio.float32, count=1)
    
    # Save probability
    with rasterio.open(PROBABILITY_FILE, 'w', **profile) as dst:
        dst.write(probability, 1)
    
    size_mb = PROBABILITY_FILE.stat().st_size / (1024**2)
    print(f"✓ Probability map saved: {PROBABILITY_FILE.name}")
    print(f"  Size: {size_mb:.1f} MB")
    
    # Create and save binary mask
    mask = (probability > PROBABILITY_THRESHOLD).astype(np.float32)
    
    with rasterio.open(MASK_FILE, 'w', **profile) as dst:
        dst.write(mask, 1)
    
    size_mb = MASK_FILE.stat().st_size / (1024**2)
    print(f"✓ Binary mask saved: {MASK_FILE.name}")
    print(f"  Size: {size_mb:.1f} MB")
    
    # Statistics
    print(f"\n[DETECTION STATISTICS]")
    print(f"  Threshold: {PROBABILITY_THRESHOLD}")
    
    pixel_counts = {
        "total": mask.size,
        "positive": int((mask > 0).sum()),
        "negative": int((mask == 0).sum()),
    }
    pixel_counts["pct_positive"] = 100.0 * pixel_counts["positive"] / pixel_counts["total"]
    
    print(f"  Positive pixels: {pixel_counts['positive']} ({pixel_counts['pct_positive']:.3f}%)")
    print(f"  Negative pixels: {pixel_counts['negative']} ({100.0 - pixel_counts['pct_positive']:.3f}%)")
    
    # Thresholds
    print(f"\n[PROBABILITY THRESHOLD ANALYSIS]")
    for thresh in [0.1, 0.3, 0.5, 0.7, 0.9]:
        count = int((probability > thresh).sum())
        pct = 100.0 * count / probability.size
        print(f"  Pixels > {thresh}: {count:,} ({pct:.4f}%)")
    
    return pixel_counts

# ============================================================================
# STEP 5: Visualization
# ============================================================================

def visualize_results(sigma0: np.ndarray, probability: np.ndarray):
    """Generate publication-ready visualizations."""
    print("\n" + "="*70)
    print("[STEP 5] Visualization")
    print("="*70)
    
    try:
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
        import matplotlib.patches as mpatches
    except:
        print("✗ Matplotlib not available, skipping visualization")
        return
    
    fig, axes = plt.subplots(1, 3, figsize=(18, 5))
    fig.suptitle(f"Real Sentinel-1 U-Net Inference: {EVENT_ID}", fontsize=14, fontweight="bold")
    
    # Subplot 1: Sigma0 dB
    ax = axes[0]
    valid = np.isfinite(sigma0)
    vmin, vmax = np.nanmin(sigma0), np.nanmax(sigma0)
    im1 = ax.imshow(sigma0, cmap='gray_r', vmin=vmin, vmax=vmax)
    ax.set_title("Sentinel-1 Sigma0 dB (VV)")
    ax.set_xlabel("X (pixels)")
    ax.set_ylabel("Y (pixels)")
    cbar1 = plt.colorbar(im1, ax=ax, label="dB")
    
    stats_text = f"Min: {np.nanmin(sigma0):.1f} dB\nMax: {np.nanmax(sigma0):.1f} dB\nMean: {np.nanmean(sigma0):.1f} dB"
    ax.text(0.98, 0.02, stats_text, transform=ax.transAxes, 
            fontsize=9, verticalalignment='bottom', horizontalalignment='right',
            bbox=dict(boxstyle='round', facecolor='wheat', alpha=0.8))
    
    # Subplot 2: Probability map
    ax = axes[1]
    im2 = ax.imshow(probability, cmap='hot', vmin=0, vmax=1)
    ax.set_title("U-Net Probability (Oil Spill)")
    ax.set_xlabel("X (pixels)")
    ax.set_ylabel("Y (pixels)")
    cbar2 = plt.colorbar(im2, ax=ax, label="Probability")
    
    # Subplot 3: Overlay
    ax = axes[2]
    ax.imshow(sigma0, cmap='gray_r', vmin=vmin, vmax=vmax, alpha=0.7)
    contour = ax.contourf(probability, levels=[PROBABILITY_THRESHOLD, 1.0], colors=['red'], alpha=0.4)
    ax.contour(probability, levels=[PROBABILITY_THRESHOLD], colors=['red'], linewidths=2)
    ax.set_title(f"Overlay (Threshold={PROBABILITY_THRESHOLD})")
    ax.set_xlabel("X (pixels)")
    ax.set_ylabel("Y (pixels)")
    
    red_patch = mpatches.Patch(color='red', alpha=0.4, label=f'Detection (>{PROBABILITY_THRESHOLD})')
    ax.legend(handles=[red_patch], loc='upper right')
    
    plt.tight_layout()
    
    # Save figure
    viz_file = OUTPUT_DIR / f"{EVENT_ID}_visualization.png"
    plt.savefig(viz_file, dpi=100, bbox_inches='tight')
    
    size_mb = viz_file.stat().st_size / (1024**2)
    print(f"✓ Visualization saved: {viz_file.name}")
    print(f"  Size: {size_mb:.1f} MB")
    
    plt.close()

# ============================================================================
# MAIN
# ============================================================================

def main():
    """Execute inference pipeline."""
    print("\n" + "="*70)
    print("REAL SENTINEL-1 U-NET INFERENCE PIPELINE")
    print("="*70)
    print(f"Input: Real Sentinel-1 Sigma0 VV data (2025-07-04)")
    print(f"Model: SAROilSpillUNet (4-level encoder-decoder)")
    print(f"Start time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S UTC')}")
    print("="*70)
    
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    
    try:
        # Step 1: Load data
        sigma0, profile = load_sigma0_data()
        if sigma0 is None:
            return False
        
        # Step 2: Load model
        model, device = load_model()
        if model is None:
            return False
        
        # Step 3: Run inference
        probability = run_tiled_inference(sigma0, model, device)
        
        # Step 4: Save outputs
        pixel_counts = save_outputs(probability, profile)
        
        # Step 5: Visualize
        visualize_results(sigma0, probability)
        
        # Summary
        print("\n" + "="*70)
        print("INFERENCE COMPLETE")
        print("="*70)
        print(f"\nOutput Files:")
        print(f"  Probability: {PROBABILITY_FILE.name}")
        print(f"  Mask: {MASK_FILE.name}")
        print(f"  Visualization: {OUTPUT_DIR / f'{EVENT_ID}_visualization.png'}")
        
        print(f"\nDETECTION RESULT:")
        if pixel_counts['positive'] > 0:
            print(f"  ✓ DETECTION: {pixel_counts['positive']:,} positive pixels ({pixel_counts['pct_positive']:.3f}%)")
        else:
            print(f"  ○ NO DETECTION: 0 pixels above {PROBABILITY_THRESHOLD} threshold")
            print(f"    (Model output too conservative for this scene)")
        
        print(f"\nEnd time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S UTC')}")
        
        return True
        
    except Exception as e:
        print(f"\n✗ Pipeline failed: {e}")
        import traceback
        traceback.print_exc()
        return False

if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1)
