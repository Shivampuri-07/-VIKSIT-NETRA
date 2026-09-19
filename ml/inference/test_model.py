import os
import sys
import json
import numpy as np
import torch
import rasterio
from PIL import Image

# Project root
PROJECT_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "../..")
)
sys.path.insert(0, PROJECT_ROOT)

from ml.models.unet import SAROilSpillUNet


# --------------------------------------------------
# PATHS
# --------------------------------------------------

DATASET_ROOT = os.path.join(
    PROJECT_ROOT,
    "ml",
    "datasets",
    "radar_data",
    "Radar_data"
)

TEST_IMAGES = os.path.join(DATASET_ROOT, "test", "images")
TEST_MASKS = os.path.join(DATASET_ROOT, "test", "masks")

CHECKPOINT = os.path.join(
    PROJECT_ROOT,
    "ml",
    "checkpoints",
    "unet_oil_spill_best.pth"
)

OUTPUT_DIR = os.path.join(PROJECT_ROOT, "ml", "results")
PRED_DIR = os.path.join(OUTPUT_DIR, "predictions")
OVERLAY_DIR = os.path.join(OUTPUT_DIR, "overlays")

os.makedirs(PRED_DIR, exist_ok=True)
os.makedirs(OVERLAY_DIR, exist_ok=True)


# --------------------------------------------------
# DEVICE
# --------------------------------------------------

if torch.backends.mps.is_available():
    DEVICE = torch.device("mps")
elif torch.cuda.is_available():
    DEVICE = torch.device("cuda")
else:
    DEVICE = torch.device("cpu")

print("=" * 70)
print("OIL SPILL MODEL TEST")
print("=" * 70)
print(f"Device: {DEVICE}")
print(f"Checkpoint: {CHECKPOINT}")


# --------------------------------------------------
# LOAD MODEL
# --------------------------------------------------

model = SAROilSpillUNet(
    in_channels=1,
    num_classes=1
)

checkpoint = torch.load(
    CHECKPOINT,
    map_location="cpu"
)

# Support both plain state_dict and checkpoint dictionary
if "model_state_dict" in checkpoint:
    model.load_state_dict(checkpoint["model_state_dict"])
else:
    model.load_state_dict(checkpoint)

model.to(DEVICE)
model.eval()

print("Model loaded successfully.")


# --------------------------------------------------
# METRICS
# --------------------------------------------------

def calculate_metrics(pred, target):
    pred = pred.astype(bool)
    target = target.astype(bool)

    intersection = np.logical_and(pred, target).sum()
    union = np.logical_or(pred, target).sum()

    pred_pixels = pred.sum()
    target_pixels = target.sum()

    dice = (
        2.0 * intersection /
        (pred_pixels + target_pixels + 1e-8)
    )

    iou = (
        intersection /
        (union + 1e-8)
    )

    precision = (
        intersection /
        (pred_pixels + 1e-8)
    )

    recall = (
        intersection /
        (target_pixels + 1e-8)
    )

    return dice, iou, precision, recall


# --------------------------------------------------
# IMAGE NORMALIZATION
# --------------------------------------------------

def normalize_image(image):
    image = image.astype(np.float32)

    valid = np.isfinite(image)

    if valid.any():
        values = image[valid]

        mean = values.mean()
        std = values.std()

        image = (image - mean) / (std + 1e-6)

    else:
        image = np.zeros_like(image)

    image = np.nan_to_num(
        image,
        nan=0.0,
        posinf=0.0,
        neginf=0.0,
    )

    return image.astype(np.float32)


# --------------------------------------------------
# TEST
# --------------------------------------------------

image_files = sorted([
    f for f in os.listdir(TEST_IMAGES)
    if f.lower().endswith((".tif", ".tiff"))
])

print(f"Test images found: {len(image_files)}")
print()

all_metrics = []


for index, filename in enumerate(image_files, start=1):

    image_path = os.path.join(TEST_IMAGES, filename)
    mask_path = os.path.join(TEST_MASKS, filename)

    print(f"[{index}/{len(image_files)}] {filename}")

    # ----------------------------------------------
    # Read SAR image
    # ----------------------------------------------

    with rasterio.open(image_path) as src:
        image = src.read(1)

    image = normalize_image(image)

    # ----------------------------------------------
    # Read ground truth mask
    # ----------------------------------------------

    with rasterio.open(mask_path) as src:
        mask = src.read(1)

    mask = (mask > 0.5).astype(np.uint8)

    # ----------------------------------------------
    # Patch-based inference
    # ----------------------------------------------

    height, width = image.shape

    prediction = np.zeros(
        (height, width),
        dtype=np.uint8
    )

    # Count overlapping predictions
    count = np.zeros(
        (height, width),
        dtype=np.uint16
    )

    patch_size = 256
    stride = 256

    with torch.no_grad():

        for y in range(0, height - patch_size + 1, stride):

            for x in range(0, width - patch_size + 1, stride):

                patch = image[
                    y:y + patch_size,
                    x:x + patch_size
                ]

                tensor = torch.from_numpy(
                    patch
                ).float().unsqueeze(0).unsqueeze(0)

                tensor = tensor.to(DEVICE)

                logits = model(tensor)

                probability = torch.sigmoid(logits)

                pred_patch = (
                    probability[0, 0].cpu().numpy() > 0.5
                ).astype(np.uint8)

                prediction[
                    y:y + patch_size,
                    x:x + patch_size
                ] += pred_patch

                count[
                    y:y + patch_size,
                    x:x + patch_size
                ] += 1

    # Convert overlapping predictions
    valid = count > 0

    final_prediction = np.zeros_like(prediction)

    final_prediction[valid] = (
        prediction[valid] / count[valid] >= 0.5
    ).astype(np.uint8)

    # ----------------------------------------------
    # Metrics
    # ----------------------------------------------

    dice, iou, precision, recall = calculate_metrics(
        final_prediction,
        mask
    )

    print(
        f"  Dice={dice:.4f} | "
        f"IoU={iou:.4f} | "
        f"Precision={precision:.4f} | "
        f"Recall={recall:.4f}"
    )

    all_metrics.append({
        "image": filename,
        "dice": float(dice),
        "iou": float(iou),
        "precision": float(precision),
        "recall": float(recall)
    })

    # ----------------------------------------------
    # Save prediction
    # ----------------------------------------------

    pred_path = os.path.join(
        PRED_DIR,
        filename.replace(".tif", "_prediction.png")
    )

    Image.fromarray(
        final_prediction * 255
    ).save(pred_path)

    # ----------------------------------------------
    # Save visual overlay
    # ----------------------------------------------

    sar_uint8 = (
        normalize_image(image) * 255
    ).astype(np.uint8)

    rgb = np.stack(
        [sar_uint8, sar_uint8, sar_uint8],
        axis=-1
    )

    # Red overlay for predicted oil
    rgb[final_prediction == 1] = [255, 0, 0]

    overlay_path = os.path.join(
        OVERLAY_DIR,
        filename.replace(".tif", "_overlay.png")
    )

    Image.fromarray(rgb).save(overlay_path)


# --------------------------------------------------
# SUMMARY
# --------------------------------------------------

mean_dice = np.mean([
    x["dice"] for x in all_metrics
])

mean_iou = np.mean([
    x["iou"] for x in all_metrics
])

mean_precision = np.mean([
    x["precision"] for x in all_metrics
])

mean_recall = np.mean([
    x["recall"] for x in all_metrics
])


results = {
    "mean_dice": float(mean_dice),
    "mean_iou": float(mean_iou),
    "mean_precision": float(mean_precision),
    "mean_recall": float(mean_recall),
    "images": all_metrics
}

with open(
    os.path.join(OUTPUT_DIR, "test_metrics.json"),
    "w"
) as f:
    json.dump(results, f, indent=2)


print()
print("=" * 70)
print("TEST COMPLETE")
print("=" * 70)

print(f"Mean Dice      : {mean_dice:.4f}")
print(f"Mean IoU       : {mean_iou:.4f}")
print(f"Mean Precision : {mean_precision:.4f}")
print(f"Mean Recall    : {mean_recall:.4f}")

print()
print(f"Results saved to: {OUTPUT_DIR}")