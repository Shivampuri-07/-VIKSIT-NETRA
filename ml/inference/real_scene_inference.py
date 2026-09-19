import os
import numpy as np
import rasterio
import torch
from ml.models.unet import SAROilSpillUNet

INPUT = "data/sentinel1/copernicus_sigma0_test.tif"
OUTPUT = "data/sentinel1/copernicus_oil_probability.tif"
CHECKPOINT = "ml/checkpoints/unet_oil_spill_best.pth"

device = torch.device(
    "mps" if torch.backends.mps.is_available()
    else "cuda" if torch.cuda.is_available()
    else "cpu"
)

print("Device:", device)

# Load image
with rasterio.open(INPUT) as src:
    image = src.read(1).astype(np.float32)
    profile = src.profile.copy()

valid = np.isfinite(image)

mean = image[valid].mean()
std = image[valid].std()

print("Input mean:", mean)
print("Input std:", std)

# Same normalization used during training
image = np.nan_to_num(image, nan=0.0, posinf=0.0, neginf=0.0)
image = (image - mean) / (std + 1e-6)

# Load model
model = SAROilSpillUNet(
    in_channels=1,
    num_classes=1,
    bilinear=True
)

checkpoint = torch.load(
    CHECKPOINT,
    map_location=device,
    weights_only=False
)

if "model_state_dict" in checkpoint:
    model.load_state_dict(checkpoint["model_state_dict"])
else:
    model.load_state_dict(checkpoint)

model.to(device)
model.eval()

print("Model loaded.")

# 256x256 tiled inference
tile_size = 256
overlap = 32
stride = tile_size - overlap

h, w = image.shape

probability = np.zeros((h, w), dtype=np.float32)
count = np.zeros((h, w), dtype=np.float32)

with torch.no_grad():

    for row in range(0, h, stride):
        for col in range(0, w, stride):

            r2 = min(row + tile_size, h)
            c2 = min(col + tile_size, w)

            tile = image[row:r2, col:c2]

            ph = tile_size - tile.shape[0]
            pw = tile_size - tile.shape[1]

            if ph > 0 or pw > 0:
                tile = np.pad(
                    tile,
                    ((0, ph), (0, pw)),
                    mode="reflect"
                )

            x = torch.from_numpy(tile).unsqueeze(0).unsqueeze(0)
            x = x.to(device)

            logits = model(x)
            probs = torch.sigmoid(logits)[0, 0].cpu().numpy()

            probs = probs[:r2-row, :c2-col]

            probability[row:r2, col:c2] += probs
            count[row:r2, col:c2] += 1

            print(
                f"\rProcessing row={row}/{h}, col={col}/{w}",
                end=""
            )

probability /= np.maximum(count, 1)

print("\nInference complete.")

# Save probability map
profile.update(
    dtype="float32",
    count=1,
    compress="deflate"
)

with rasterio.open(OUTPUT, "w", **profile) as dst:
    dst.write(probability, 1)

print("Saved:", OUTPUT)

# Statistics
print("Probability min:", probability.min())
print("Probability max:", probability.max())
print("Probability mean:", probability.mean())

for threshold in [0.3, 0.5, 0.7, 0.9]:
    pixels = (probability >= threshold).sum()
    percent = pixels / probability.size * 100
    print(
        f"Threshold {threshold}: "
        f"{pixels} pixels ({percent:.4f}%)"
    )
