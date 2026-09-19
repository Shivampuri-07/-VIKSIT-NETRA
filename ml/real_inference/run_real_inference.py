from pathlib import Path
import numpy as np
import torch

from ml.models.unet import SAROilSpillUNet


TILES = Path("data/sentinel1/event_tiles")
OUT = Path("data/sentinel1/event_predictions")
CHECKPOINT = Path("ml/checkpoints/unet_oil_spill_best.pth")

OUT.mkdir(parents=True, exist_ok=True)

device = torch.device(
    "mps" if torch.backends.mps.is_available()
    else "cuda" if torch.cuda.is_available()
    else "cpu"
)

print("Device:", device)

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

tiles = sorted(TILES.glob("*.npy"))

print("Tiles found:", len(tiles))

total_positive = 0

with torch.no_grad():

    for i, tile_path in enumerate(tiles, 1):

        image = np.load(tile_path).astype(np.float32)

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
            neginf=0.0
        )

        x = torch.from_numpy(image).unsqueeze(0).unsqueeze(0)
        x = x.to(device)

        logits = model(x)
        probability = torch.sigmoid(logits)[0, 0].cpu().numpy()

        mask = probability >= 0.5

        total_positive += int(mask.sum())

        np.save(
            OUT / tile_path.name,
            mask.astype(np.uint8)
        )

        if i % 50 == 0 or i == len(tiles):
            print(
                f"{i}/{len(tiles)} | "
                f"positive pixels: {int(mask.sum())}"
            )

print("\nINFERENCE COMPLETE")
print("Prediction directory:", OUT)
print("Total predicted positive pixels:", total_positive)
