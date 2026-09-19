"""
Real-data training script for SAR Oil Spill U-Net Segmentation.

Dataset:
    ml/datasets/radar_data/Radar_data   (Zenodo 10.5281/zenodo.4672426; NOT
    bundled in the repository, see ml/model_registry.json)

Uses:
    - Real Sentinel-1 oil-spill dataset
    - BCE + Dice loss (0.4 BCE + 0.6 Dice)
    - Apple MPS / CUDA / CPU
    - Train + validation CSVs
    - Best checkpoint based on validation Dice

BASELINE PROTECTION
    This script can NEVER write ml/checkpoints/unet_oil_spill_best.pth (the
    production baseline). Every run writes only to a new directory
        ml/checkpoints/candidates/<UTC timestamp>_<run name>/
    containing candidate_best.pth, run_config.json and metrics_history.json.
    A candidate replaces nothing; promotion requires a benchmark against the
    frozen baseline on the same held-out test scenes (ml/model_registry.json).

    Epoch count is an experiment parameter. A 6-epoch run is an experiment;
    it is not "better" unless the test-scene benchmark shows it.

Usage (from any directory):
    python ml/training/train.py --dry-run                 # validate data, write nothing
    python ml/training/train.py --epochs 3 --seed 42
    python ml/training/train.py --epochs 6 --run-name six_epoch_experiment
"""

import argparse
import json
import os
import random
import sys
import time
from typing import Dict, Any, Optional

# Add project root to Python path
PROJECT_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "../..")
)
sys.path.insert(0, PROJECT_ROOT)

from ml.training.run_guard import (  # noqa: E402  (torch-free)
    assert_not_production,
    assert_safe_candidate_output,
    new_candidate_run_dir,
    protected_checkpoint_fingerprints,
    validate_dataset_layout,
)

from ml.data_root import radar_dataset_root  # noqa: E402  (AEGIS_DATA_ROOT, else the repo-local path)

DEFAULT_DATASET_ROOT = str(radar_dataset_root())

try:  # torch is required for training, not for --dry-run data preflight
    import torch
    import torch.nn as nn
    import torch.optim as optim
    from torch.utils.data import DataLoader
except ImportError:  # pragma: no cover - exercised in torch-free environments
    torch = None


if torch is not None:

    class DiceBCELoss(nn.Module):
        def __init__(
            self,
            dice_weight: float = 0.6,
            bce_weight: float = 0.4,
            smooth: float = 1e-6,
        ):
            super().__init__()
            self.dice_weight = dice_weight
            self.bce_weight = bce_weight
            self.smooth = smooth
            self.bce = nn.BCEWithLogitsLoss()

        def forward(self, logits, targets):
            bce_loss = self.bce(logits, targets)

            probs = torch.sigmoid(logits)

            p_flat = probs.reshape(-1)
            t_flat = targets.reshape(-1)

            intersection = (p_flat * t_flat).sum()

            dice = (
                2.0 * intersection + self.smooth
            ) / (
                p_flat.sum() + t_flat.sum() + self.smooth
            )

            dice_loss = 1.0 - dice

            return (
                self.bce_weight * bce_loss
                + self.dice_weight * dice_loss
            )


def _write_json(path: str, obj: Dict[str, Any]) -> None:
    assert_safe_candidate_output(path)
    with open(path, "w") as f:
        json.dump(obj, f, indent=2, default=str)


def _set_seed(seed: int) -> None:
    random.seed(seed)
    try:
        import numpy as np
        np.random.seed(seed)
    except ImportError:
        pass
    if torch is not None:
        torch.manual_seed(seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(seed)


def _augment(images, masks, generator):
    """Joint random flips / 90-degree rotations of a batch (geometric only; SAR radiometry untouched)."""
    k = int(torch.randint(0, 4, (1,), generator=generator))
    if k:
        images, masks = torch.rot90(images, k, dims=(2, 3)), torch.rot90(masks, k, dims=(2, 3))
    if int(torch.randint(0, 2, (1,), generator=generator)):
        images, masks = torch.flip(images, dims=(3,)), torch.flip(masks, dims=(3,))
    return images, masks


def dry_run(dataset_root: str = DEFAULT_DATASET_ROOT) -> Dict[str, Any]:
    """
    Validate data and environment WITHOUT writing anything:
      1. dataset layout / CSVs / referenced files / train-val leakage (torch-free)
      2. if torch + rasterio are available: load one train and one val sample,
         run one forward + backward pass (no optimizer step, nothing saved)
    """
    report: Dict[str, Any] = {
        "dataset": validate_dataset_layout(dataset_root),
        "protected_checkpoints": protected_checkpoint_fingerprints(),
        "torch_available": torch is not None,
    }
    if torch is None:
        report["model_step"] = "SKIPPED: PyTorch not installed (data preflight only)"
        return report
    if not report["dataset"]["ok"]:
        report["model_step"] = "SKIPPED: dataset preflight failed"
        return report

    from ml.models.unet import SAROilSpillUNet
    from ml.datasets.dataset import SAROilSpillDataset

    _set_seed(0)
    train_ds = SAROilSpillDataset(root_dir=dataset_root, split="train", normalize=True)
    val_ds = SAROilSpillDataset(root_dir=dataset_root, split="val", normalize=True)
    image, mask = train_ds[0]
    v_image, v_mask = val_ds[0]
    model = SAROilSpillUNet(in_channels=1, num_classes=1)
    logits = model(image.unsqueeze(0))
    loss = DiceBCELoss()(logits, mask.unsqueeze(0))
    loss.backward()
    report["model_step"] = {
        "train_sample_shape": list(image.shape),
        "val_sample_shape": list(v_image.shape),
        "mask_values": sorted({float(x) for x in mask.unique().tolist()}),
        "logits_shape": list(logits.shape),
        "loss": float(loss.item()),
        "note": "one forward/backward pass; no optimizer step; nothing saved",
    }
    return report


def train_model(
    epochs: int = 3,
    batch_size: int = 4,
    learning_rate: float = 1e-3,
    seed: int = 42,
    dataset_root: str = DEFAULT_DATASET_ROOT,
    run_name: Optional[str] = None,
    normalization: str = "patch",
    early_stopping_patience: int = 0,
    augment: bool = False,
    lr_scheduler: str = "none",
):
    if torch is None:
        raise RuntimeError("PyTorch is required for training (use --dry-run for a data preflight).")

    from ml.models.unet import SAROilSpillUNet, get_device
    from ml.datasets.dataset import SAROilSpillDataset
    from ml.metrics.evaluation import calculate_metrics

    print("=" * 70)
    print("AEGIS — REAL OIL SPILL U-NET TRAINING (CANDIDATE RUN)")
    print("=" * 70)

    # ---------------------------------------------------------
    # PREFLIGHT + RUN DIRECTORY (never the production checkpoint)
    # ---------------------------------------------------------
    preflight = validate_dataset_layout(dataset_root)
    if not preflight["ok"]:
        raise RuntimeError("Dataset preflight failed: " + "; ".join(preflight["errors"]))
    for w in preflight["warnings"]:
        print(f"[Preflight] WARNING: {w}")

    run_dir = str(new_candidate_run_dir(run_name or f"e{epochs}_s{seed}"))
    save_path = os.path.join(run_dir, "candidate_best.pth")
    assert_safe_candidate_output(save_path)

    _set_seed(seed)
    device = get_device()
    print(f"[Train] Device: {device}")
    print(f"[Train] Run directory: {run_dir}")
    print(f"[Train] Dataset: {dataset_root}")

    config = {
        "status": "CANDIDATE - not a production model",
        "created_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "epochs": epochs,
        "batch_size": batch_size,
        "learning_rate": learning_rate,
        "weight_decay": 1e-4,
        "optimizer": "AdamW",
        "loss": "0.6 Dice + 0.4 BCEWithLogits",
        "seed": seed,
        "normalization": normalization,
        "early_stopping_patience": early_stopping_patience,
        "augmentation": "random rot90 + horizontal flip (joint image/mask)" if augment else None,
        "lr_scheduler": lr_scheduler,
        "architecture": "SAROilSpillUNet(in_channels=1, num_classes=1, bilinear=True) - unchanged",
        "device": str(device),
        "torch_version": torch.__version__,
        "dataset_root": dataset_root,
        "dataset_preflight": preflight,
        "baseline_checkpoints_at_start": protected_checkpoint_fingerprints(),
        "note": "Epoch count is an experiment parameter; no improvement over the baseline is implied. "
                "Promotion requires a benchmark on the held-out test scenes (ml/model_registry.json policy).",
    }
    _write_json(os.path.join(run_dir, "run_config.json"), config)

    # ---------------------------------------------------------
    # REAL DATASET
    # ---------------------------------------------------------
    train_dataset = SAROilSpillDataset(
        root_dir=dataset_root,
        split="train",
        normalize=True,
        normalization=normalization,
    )

    val_dataset = SAROilSpillDataset(
        root_dir=dataset_root,
        split="val",
        normalize=True,
        normalization=normalization,
    )

    print(f"[Train] Training samples: {len(train_dataset)}")
    print(f"[Train] Validation samples: {len(val_dataset)}")

    # ---------------------------------------------------------
    # DATA LOADERS
    # ---------------------------------------------------------
    generator = torch.Generator()
    generator.manual_seed(seed)

    train_loader = DataLoader(
        train_dataset,
        batch_size=batch_size,
        shuffle=True,
        num_workers=0,
        generator=generator,
    )

    val_loader = DataLoader(
        val_dataset,
        batch_size=batch_size,
        shuffle=False,
        num_workers=0,
    )

    # ---------------------------------------------------------
    # MODEL
    # ---------------------------------------------------------
    model = SAROilSpillUNet(
        in_channels=1,
        num_classes=1,
    ).to(device)

    criterion = DiceBCELoss()

    optimizer = optim.AdamW(
        model.parameters(),
        lr=learning_rate,
        weight_decay=1e-4,
    )

    scheduler = (
        optim.lr_scheduler.ReduceLROnPlateau(optimizer, mode="max", factor=0.5, patience=1)
        if lr_scheduler == "plateau" else None
    )
    aug_generator = torch.Generator()
    aug_generator.manual_seed(seed + 1)

    best_val_dice = 0.0
    best_epoch = None
    epochs_without_improvement = 0
    history = []
    run_started = time.time()
    stopped_early = False

    # ---------------------------------------------------------
    # TRAINING LOOP
    # ---------------------------------------------------------
    for epoch in range(1, epochs + 1):

        epoch_start = time.time()

        # =========================
        # TRAIN
        # =========================
        model.train()

        running_loss = 0.0

        for batch_idx, (images, masks) in enumerate(train_loader):

            images = images.to(device)
            masks = masks.to(device)

            if augment:
                images, masks = _augment(images, masks, aug_generator)

            optimizer.zero_grad()

            logits = model(images)

            loss = criterion(logits, masks)

            loss.backward()

            optimizer.step()

            running_loss += loss.item()

            if (batch_idx + 1) % 100 == 0:
                print(
                    f"Epoch {epoch}/{epochs} | "
                    f"Batch {batch_idx + 1}/{len(train_loader)} | "
                    f"Loss {loss.item():.4f}"
                )

        avg_train_loss = running_loss / len(train_loader)

        # =========================
        # VALIDATION
        # =========================
        model.eval()

        dice_scores = []
        iou_scores = []
        precision_scores = []
        recall_scores = []

        with torch.no_grad():

            for images, masks in val_loader:

                images = images.to(device)
                masks = masks.to(device)

                preds, probs = model.predict_mask(images)

                metrics = calculate_metrics(
                    preds,
                    masks,
                )

                dice_scores.append(metrics["dice"])
                iou_scores.append(metrics["iou"])
                precision_scores.append(metrics["precision"])
                recall_scores.append(metrics["recall"])

        avg_dice = sum(dice_scores) / len(dice_scores)
        avg_iou = sum(iou_scores) / len(iou_scores)
        avg_precision = sum(precision_scores) / len(precision_scores)
        avg_recall = sum(recall_scores) / len(recall_scores)

        elapsed = time.time() - epoch_start

        print()
        print("-" * 70)
        print(
            f"Epoch {epoch}/{epochs} "
            f"| Time: {elapsed:.1f}s"
        )
        print(f"Train Loss : {avg_train_loss:.4f}")
        print(f"Val Dice   : {avg_dice:.4f}")
        print(f"Val IoU    : {avg_iou:.4f}")
        print(f"Precision  : {avg_precision:.4f}")
        print(f"Recall     : {avg_recall:.4f}")
        print("-" * 70)

        history.append({
            "epoch": epoch, "train_loss": avg_train_loss, "val_dice": avg_dice, "val_iou": avg_iou,
            "val_precision": avg_precision, "val_recall": avg_recall, "seconds": elapsed,
            "aggregation": "mean of per-batch metrics (validation split; see leakage warning in run_config.json)",
        })
        hist_path = os.path.join(run_dir, "metrics_history.json")
        assert_not_production(hist_path)
        with open(hist_path, "w") as f:
            json.dump(history, f, indent=2)

        # -----------------------------------------------------
        # SAVE BEST MODEL (candidate directory only)
        # -----------------------------------------------------
        if scheduler is not None:
            scheduler.step(avg_dice)

        if avg_dice > best_val_dice:

            best_val_dice = avg_dice
            best_epoch = epoch
            epochs_without_improvement = 0

            assert_not_production(save_path)  # defence in depth: re-checked before every write
            torch.save(
                {
                    "model_state_dict": model.state_dict(),
                    "epoch": epoch,
                    "val_dice": avg_dice,
                    "val_iou": avg_iou,
                    "val_precision": avg_precision,
                    "val_recall": avg_recall,
                    "candidate": True,
                    "seed": seed,
                    "run_dir": run_dir,
                },
                save_path,
            )

            print(
                f"[Checkpoint] Best candidate saved → {save_path}"
            )
        else:
            epochs_without_improvement += 1
            if early_stopping_patience and epochs_without_improvement >= early_stopping_patience:
                print(f"[Train] Early stopping: no validation-Dice improvement for {epochs_without_improvement} epoch(s).")
                stopped_early = True
                break

    summary = {
        "status": "COMPLETED",
        "epochs_requested": epochs,
        "epochs_run": len(history),
        "stopped_early": stopped_early,
        "best_epoch": best_epoch,
        "best_val_dice": best_val_dice,
        "best_val_metrics": next((h for h in history if h["epoch"] == best_epoch), None),
        "duration_seconds": round(time.time() - run_started, 1),
        "seed": seed,
        "validation_caveat": "; ".join(preflight["warnings"]) or None,
        "validation_independent": not any("leakage" in w for w in preflight["warnings"]),
        "checkpoint": os.path.relpath(save_path, PROJECT_ROOT),
        "production_checkpoint_modified": False,
        "promotion": "NOT decided here. Run ml/evaluation/run_eval.py + ml/evaluation/compare_candidate.py on the held-out test scenes.",
    }
    _write_json(os.path.join(run_dir, "run_summary.json"), summary)

    print()
    print("=" * 70)
    print("TRAINING COMPLETE (CANDIDATE)")
    print("=" * 70)
    print(f"Best Validation Dice: {best_val_dice:.4f}")
    print(f"Candidate checkpoint: {save_path}")
    print("The production baseline was not modified. Compare on the test scenes before any promotion.")

    return {
        "status": "COMPLETED",
        "best_val_dice": best_val_dice,
        "checkpoint": save_path,
        "run_dir": run_dir,
        "production_checkpoint_modified": False,
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Train a CANDIDATE U-Net (never overwrites the production baseline).")
    ap.add_argument("--epochs", type=int, default=3, help="default 3 (the original configuration)")
    ap.add_argument("--batch-size", type=int, default=4)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--dataset-root", default=DEFAULT_DATASET_ROOT)
    ap.add_argument("--run-name", default=None)
    ap.add_argument("--dry-run", action="store_true", help="validate data/environment; write nothing")
    ap.add_argument("--normalization", choices=["patch", "scene"], default="patch",
                    help="patch = original training preprocessing; scene = matches evaluation/inference")
    ap.add_argument("--early-stopping-patience", type=int, default=0, help="0 = off (original behaviour)")
    ap.add_argument("--augment", action="store_true", help="random rot90/flip augmentation (off by default)")
    ap.add_argument("--lr-scheduler", choices=["none", "plateau"], default="none")
    a = ap.parse_args(argv)
    if a.dry_run:
        rep = dry_run(a.dataset_root)
        print(json.dumps(rep, indent=2, default=str))
        return 0 if rep["dataset"]["ok"] else 2
    train_model(epochs=a.epochs, batch_size=a.batch_size, learning_rate=a.lr, seed=a.seed,
                dataset_root=a.dataset_root, run_name=a.run_name, normalization=a.normalization,
                early_stopping_patience=a.early_stopping_patience, augment=a.augment, lr_scheduler=a.lr_scheduler)
    return 0


if __name__ == "__main__":
    sys.exit(main())
