cat > ml/test_real_dataset.py <<'PY'
from pathlib import Path
import numpy as np

from ml.datasets.dataset import SAROilSpillDataset

DATASET_ROOT = Path("ml/datasets/radar_data/Radar_data")

print("Starting dataset validation...")

dataset = SAROilSpillDataset(
    root_dir=str(DATASET_ROOT),
    split="train",
)

print("Total samples:", len(dataset))

positive = 0
negative = 0
first_positive = None

for i in range(len(dataset)):
    image, mask = dataset[i]

    if mask.sum().item() > 0:
        positive += 1
        if first_positive is None:
            first_positive = i
    else:
        negative += 1

print("\nRESULT")
print("Positive patches:", positive)
print("Negative patches:", negative)

if first_positive is not None:
    image, mask = dataset[first_positive]

    print("\nFirst positive patch index:", first_positive)
    print("Image shape:", image.shape)
    print("Mask shape:", mask.shape)
    print("Mask unique:", mask.unique().tolist())
    print("Oil pixels:", int(mask.sum().item()))
else:
    print("\nWARNING: No positive patches found!")

print("\nDATASET VALIDATION COMPLETE")
PY