"""
Visualization script for Real Sentinel-1 Oil Spill Inference Results.

Reads the real Sentinel-1 VV Sigma0 and U-Net probability outputs,
handles NaN/-inf/+inf safely, and generates PNG visualizations with
optional overlay of high-probability regions.
"""

import os
import sys
import numpy as np
import rasterio
import matplotlib.pyplot as plt
import matplotlib.cm as cm
from matplotlib.colors import Normalize
import warnings

warnings.filterwarnings("ignore")

# Project root
PROJECT_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "../..")
)

# Paths
DATA_DIR = os.path.join(PROJECT_ROOT, "data", "sentinel1")
SIGMA0_TIFF = os.path.join(DATA_DIR, "copernicus_sigma0_test.tif")
PROB_TIFF = os.path.join(DATA_DIR, "copernicus_oil_probability.tif")

# Output PNG paths
SIGMA0_PNG = os.path.join(DATA_DIR, "copernicus_sigma0_visualization.png")
PROB_PNG = os.path.join(DATA_DIR, "copernicus_probability_visualization.png")
OVERLAY_PNG = os.path.join(DATA_DIR, "copernicus_overlay_visualization.png")
COMPARISON_PNG = os.path.join(DATA_DIR, "copernicus_comparison.png")


def safe_normalize_data(data, finite_only=True):
    """
    Safely normalize data, handling NaN, -inf, +inf.
    
    Args:
        data: numpy array
        finite_only: if True, only use finite values for normalization
        
    Returns:
        Normalized array with inf/-inf/NaN set to 0
    """
    # Create a copy to avoid modifying original
    clean_data = data.copy()
    
    # Replace inf and -inf with NaN temporarily for statistics
    clean_data[~np.isfinite(clean_data)] = np.nan
    
    if finite_only and np.any(np.isfinite(clean_data)):
        vmin = np.nanmin(clean_data)
        vmax = np.nanmax(clean_data)
        # Normalize to [0, 1]
        if vmin < vmax:
            normalized = (clean_data - vmin) / (vmax - vmin)
        else:
            normalized = np.zeros_like(clean_data)
    else:
        vmin = np.nanmin(clean_data) if np.any(np.isfinite(clean_data)) else 0
        vmax = np.nanmax(clean_data) if np.any(np.isfinite(clean_data)) else 1
        normalized = clean_data
    
    # Replace any remaining NaN or inf with 0 for display
    normalized[~np.isfinite(normalized)] = 0.0
    
    return normalized, vmin, vmax


def visualize_sigma0():
    """Generate visualization of Sentinel-1 VV Sigma0 dB."""
    print("Reading Sigma0 TIFF...")
    with rasterio.open(SIGMA0_TIFF) as src:
        sigma0_data = src.read(1)
    
    print(f"  Raw shape: {sigma0_data.shape}")
    print(f"  Raw dtype: {sigma0_data.dtype}")
    print(f"  Finite values: {np.isfinite(sigma0_data).sum()}")
    print(f"  NaN values: {np.isnan(sigma0_data).sum()}")
    print(f"  -inf values: {np.isinf(sigma0_data).sum()}")
    
    # Normalize
    normalized, vmin, vmax = safe_normalize_data(sigma0_data, finite_only=True)
    
    print(f"  Normalized min: {normalized.min():.4f}")
    print(f"  Normalized max: {normalized.max():.4f}")
    print(f"  Original vmin: {vmin:.4f}, vmax: {vmax:.4f}")
    
    # Create figure
    fig, ax = plt.subplots(figsize=(12, 10), dpi=100)
    
    # Use inverted grayscale (dark = low backscatter = potential oil)
    im = ax.imshow(normalized, cmap='gray_r', origin='upper')
    
    ax.set_title('Sentinel-1 VV Sigma0 (dB)\nReal Scene from Copernicus', fontsize=14, fontweight='bold')
    ax.set_xlabel('Column (pixels)', fontsize=12)
    ax.set_ylabel('Row (pixels)', fontsize=12)
    
    # Add colorbar
    cbar = plt.colorbar(im, ax=ax, label='Normalized Sigma0 Intensity')
    
    # Add statistical text box
    finite_sigma0 = sigma0_data[np.isfinite(sigma0_data)]
    stats_text = f'Finite values: {len(finite_sigma0)}\nMean: {np.mean(finite_sigma0):.2f} dB\nStd: {np.std(finite_sigma0):.2f} dB'
    ax.text(0.02, 0.98, stats_text, transform=ax.transAxes, fontsize=10,
            verticalalignment='top', bbox=dict(boxstyle='round', facecolor='wheat', alpha=0.5))
    
    plt.tight_layout()
    plt.savefig(SIGMA0_PNG, dpi=100, bbox_inches='tight')
    print(f"✓ Saved Sigma0 visualization to: {SIGMA0_PNG}")
    plt.close()


def visualize_probability():
    """Generate visualization of U-Net oil spill probability map."""
    print("\nReading Probability TIFF...")
    with rasterio.open(PROB_TIFF) as src:
        prob_data = src.read(1)
    
    print(f"  Raw shape: {prob_data.shape}")
    print(f"  Raw dtype: {prob_data.dtype}")
    print(f"  Min: {np.nanmin(prob_data):.6f}")
    print(f"  Max: {np.nanmax(prob_data):.6f}")
    print(f"  Mean: {np.nanmean(prob_data):.6e}")
    
    # Normalize for visualization
    normalized, vmin, vmax = safe_normalize_data(prob_data, finite_only=False)
    
    print(f"  Normalized min: {normalized.min():.6f}")
    print(f"  Normalized max: {normalized.max():.6f}")
    
    # Create figure
    fig, ax = plt.subplots(figsize=(12, 10), dpi=100)
    
    # Use hot colormap (hot = high probability)
    im = ax.imshow(prob_data, cmap='hot', origin='upper', vmin=0, vmax=np.nanmax(prob_data))
    
    ax.set_title('U-Net Oil Spill Probability Map\nReal Scene Inference', fontsize=14, fontweight='bold')
    ax.set_xlabel('Column (pixels)', fontsize=12)
    ax.set_ylabel('Row (pixels)', fontsize=12)
    
    # Add colorbar
    cbar = plt.colorbar(im, ax=ax, label='Oil Probability Score')
    
    # Add statistical text box
    thresholds = [0.1, 0.2, 0.3, 0.5]
    thresh_text = 'Pixels above threshold:\n'
    for t in thresholds:
        count = np.sum(prob_data > t)
        thresh_text += f'  > {t}: {count}\n'
    
    ax.text(0.02, 0.98, thresh_text, transform=ax.transAxes, fontsize=10,
            verticalalignment='top', bbox=dict(boxstyle='round', facecolor='lightblue', alpha=0.5))
    
    plt.tight_layout()
    plt.savefig(PROB_PNG, dpi=100, bbox_inches='tight')
    print(f"✓ Saved Probability visualization to: {PROB_PNG}")
    plt.close()


def visualize_overlay():
    """Generate overlay visualization showing high-probability regions on Sigma0."""
    print("\nCreating overlay visualization...")
    
    with rasterio.open(SIGMA0_TIFF) as src:
        sigma0_data = src.read(1)
    with rasterio.open(PROB_TIFF) as src:
        prob_data = src.read(1)
    
    # Normalize Sigma0
    normalized_sigma0, _, _ = safe_normalize_data(sigma0_data, finite_only=True)
    
    # Create figure with two subplots
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(18, 8), dpi=100)
    
    # Left: Sigma0 with probability contours
    ax1.imshow(normalized_sigma0, cmap='gray_r', origin='upper')
    
    # Overlay probability contours
    contour_levels = [0.01, 0.02, 0.03]
    contour = ax1.contour(prob_data, levels=contour_levels, colors='red', linewidths=1.5, alpha=0.7)
    ax1.clabel(contour, inline=True, fontsize=8)
    
    ax1.set_title('Sigma0 with Probability Contours', fontsize=12, fontweight='bold')
    ax1.set_xlabel('Column (pixels)', fontsize=10)
    ax1.set_ylabel('Row (pixels)', fontsize=10)
    
    # Right: Sigma0 with probability heatmap overlay
    ax2.imshow(normalized_sigma0, cmap='gray_r', origin='upper', alpha=0.6)
    im = ax2.imshow(prob_data, cmap='hot', origin='upper', alpha=0.6, vmin=0, vmax=np.nanmax(prob_data))
    
    ax2.set_title('Sigma0 with Probability Heatmap Overlay', fontsize=12, fontweight='bold')
    ax2.set_xlabel('Column (pixels)', fontsize=10)
    ax2.set_ylabel('Row (pixels)', fontsize=10)
    
    cbar = plt.colorbar(im, ax=ax2, label='Oil Probability')
    
    plt.tight_layout()
    plt.savefig(OVERLAY_PNG, dpi=100, bbox_inches='tight')
    print(f"✓ Saved Overlay visualization to: {OVERLAY_PNG}")
    plt.close()


def visualize_comparison():
    """Generate 2x2 comparison showing all perspectives."""
    print("\nCreating comprehensive comparison...")
    
    with rasterio.open(SIGMA0_TIFF) as src:
        sigma0_data = src.read(1)
    with rasterio.open(PROB_TIFF) as src:
        prob_data = src.read(1)
    
    # Normalize Sigma0
    normalized_sigma0, _, _ = safe_normalize_data(sigma0_data, finite_only=True)
    
    # Create 2x2 figure
    fig, axes = plt.subplots(2, 2, figsize=(16, 14), dpi=100)
    
    # Top-left: Sigma0 raw
    im1 = axes[0, 0].imshow(normalized_sigma0, cmap='gray_r', origin='upper')
    axes[0, 0].set_title('Sentinel-1 VV Sigma0\n(inverted: dark = low backscatter)', fontsize=11, fontweight='bold')
    plt.colorbar(im1, ax=axes[0, 0], label='Normalized Intensity')
    
    # Top-right: Probability raw
    im2 = axes[0, 1].imshow(prob_data, cmap='hot', origin='upper', vmin=0, vmax=np.nanmax(prob_data))
    axes[0, 1].set_title(f'U-Net Oil Probability\n(max={np.nanmax(prob_data):.6f})', fontsize=11, fontweight='bold')
    plt.colorbar(im2, ax=axes[0, 1], label='Probability')
    
    # Bottom-left: Sigma0 with contours
    axes[1, 0].imshow(normalized_sigma0, cmap='gray_r', origin='upper')
    contour_levels = [0.005, 0.01, 0.02, 0.03]
    contour = axes[1, 0].contour(prob_data, levels=contour_levels, colors='cyan', linewidths=1, alpha=0.8)
    axes[1, 0].clabel(contour, inline=True, fontsize=8)
    axes[1, 0].set_title('Sigma0 with Probability Contours', fontsize=11, fontweight='bold')
    
    # Bottom-right: Combined heatmap
    axes[1, 1].imshow(normalized_sigma0, cmap='gray_r', origin='upper', alpha=0.5)
    im3 = axes[1, 1].imshow(prob_data, cmap='hot', origin='upper', alpha=0.6, vmin=0, vmax=np.nanmax(prob_data))
    axes[1, 1].set_title('Overlay: Sigma0 + Probability Heatmap', fontsize=11, fontweight='bold')
    plt.colorbar(im3, ax=axes[1, 1], label='Probability')
    
    # Add overall statistics
    finite_sigma0 = sigma0_data[np.isfinite(sigma0_data)]
    stats_info = (
        f'Scene Statistics:\n'
        f'Sigma0 - Mean: {np.mean(finite_sigma0):.2f} dB, Std: {np.std(finite_sigma0):.2f} dB\n'
        f'Probability - Max: {np.nanmax(prob_data):.6f}, Mean: {np.nanmean(prob_data):.6e}\n'
        f'Dim: {sigma0_data.shape[0]}x{sigma0_data.shape[1]} pixels\n'
        f'High probability pixels (>0.01): {(prob_data > 0.01).sum()}'
    )
    fig.text(0.5, 0.02, stats_info, ha='center', fontsize=10, 
             bbox=dict(boxstyle='round', facecolor='lightyellow', alpha=0.7))
    
    plt.tight_layout(rect=[0, 0.08, 1, 1])
    plt.savefig(COMPARISON_PNG, dpi=100, bbox_inches='tight')
    print(f"✓ Saved Comparison visualization to: {COMPARISON_PNG}")
    plt.close()


def main():
    """Main execution."""
    print("=" * 70)
    print("SENTINEL-1 OIL SPILL INFERENCE VISUALIZATION")
    print("=" * 70)
    
    # Verify input files exist
    if not os.path.exists(SIGMA0_TIFF):
        print(f"ERROR: {SIGMA0_TIFF} not found!")
        sys.exit(1)
    
    if not os.path.exists(PROB_TIFF):
        print(f"ERROR: {PROB_TIFF} not found!")
        sys.exit(1)
    
    print(f"\nInput files:")
    print(f"  Sigma0: {SIGMA0_TIFF}")
    print(f"  Probability: {PROB_TIFF}")
    print(f"\nOutput directory: {DATA_DIR}\n")
    
    # Generate visualizations
    visualize_sigma0()
    visualize_probability()
    visualize_overlay()
    visualize_comparison()
    
    print("\n" + "=" * 70)
    print("VISUALIZATION COMPLETE")
    print("=" * 70)
    print(f"\nGenerated files:")
    print(f"  1. {SIGMA0_PNG}")
    print(f"  2. {PROB_PNG}")
    print(f"  3. {OVERLAY_PNG}")
    print(f"  4. {COMPARISON_PNG}")
    
    # Verify files exist
    print("\nVerifying output files...")
    for png_file in [SIGMA0_PNG, PROB_PNG, OVERLAY_PNG, COMPARISON_PNG]:
        if os.path.exists(png_file):
            size_kb = os.path.getsize(png_file) / 1024
            print(f"  ✓ {os.path.basename(png_file)} ({size_kb:.1f} KB)")
        else:
            print(f"  ✗ {os.path.basename(png_file)} - NOT FOUND")
    
    print("\n" + "=" * 70)


if __name__ == "__main__":
    main()
