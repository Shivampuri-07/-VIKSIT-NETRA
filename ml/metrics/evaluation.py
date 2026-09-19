"""
Evaluation metrics for Oil Spill Segmentation.
Calculates IoU (Jaccard Index), Dice (F1), Precision, Recall, and Accuracy.
Pure Python and NumPy compatible.
"""

from typing import Dict, Union, Any, List

try:
    import numpy as np
    HAS_NUMPY = True
except ImportError:
    HAS_NUMPY = False

try:
    import torch
    HAS_TORCH = True
except ImportError:
    HAS_TORCH = False


def calculate_metrics(
    pred: Any,
    target: Any,
    smooth: float = 1e-6
) -> Dict[str, float]:
    """
    Computes binary segmentation metrics between prediction and ground truth.
    Supports PyTorch tensors, NumPy arrays, or nested Python lists.
    """
    # Fast path (performance only): tensors / arrays are counted with NumPy. The confusion counts are
    # integers, so the result is exactly the one of the list implementation below.
    if HAS_NUMPY and isinstance(pred, (np.ndarray,)) or (HAS_TORCH and isinstance(pred, torch.Tensor)):
        if HAS_NUMPY and (isinstance(target, np.ndarray) or (HAS_TORCH and isinstance(target, torch.Tensor))):
            def _b(x):
                x = x.detach().cpu().numpy() if (HAS_TORCH and isinstance(x, torch.Tensor)) else x
                return np.asarray(x).astype(bool).ravel()
            p_arr, t_arr = _b(pred), _b(target)
            tp = int(np.count_nonzero(p_arr & t_arr))
            fp = int(np.count_nonzero(p_arr & ~t_arr))
            fn = int(np.count_nonzero(~p_arr & t_arr))
            tn = int(p_arr.size - tp - fp - fn)
            return _metrics_from_counts(tp, fp, fn, tn, smooth)
    if HAS_TORCH and isinstance(pred, torch.Tensor):
        p_flat = pred.detach().cpu().numpy().flatten().astype(bool).tolist()
    elif HAS_NUMPY and isinstance(pred, np.ndarray):
        p_flat = pred.flatten().astype(bool).tolist()
    elif isinstance(pred, list):
        if len(pred) > 0 and isinstance(pred[0], list):
            p_flat = [bool(x) for row in pred for x in row]
        else:
            p_flat = [bool(x) for x in pred]
    else:
        p_flat = [bool(pred)]

    if HAS_TORCH and isinstance(target, torch.Tensor):
        t_flat = target.detach().cpu().numpy().flatten().astype(bool).tolist()
    elif HAS_NUMPY and isinstance(target, np.ndarray):
        t_flat = target.flatten().astype(bool).tolist()
    elif isinstance(target, list):
        if len(target) > 0 and isinstance(target[0], list):
            t_flat = [bool(x) for row in target for x in row]
        else:
            t_flat = [bool(x) for x in target]
    else:
        t_flat = [bool(target)]

    tp = sum(1 for p, t in zip(p_flat, t_flat) if p and t)
    fp = sum(1 for p, t in zip(p_flat, t_flat) if p and not t)
    fn = sum(1 for p, t in zip(p_flat, t_flat) if not p and t)
    tn = sum(1 for p, t in zip(p_flat, t_flat) if not p and not t)
    return _metrics_from_counts(tp, fp, fn, tn, smooth)


def _metrics_from_counts(tp: int, fp: int, fn: int, tn: int, smooth: float) -> Dict[str, float]:
    intersection = tp
    union = tp + fp + fn

    iou = (intersection + smooth) / (union + smooth)
    dice = (2.0 * intersection + smooth) / (2 * tp + fp + fn + smooth)
    precision = (tp + smooth) / (tp + fp + smooth)
    recall = (tp + smooth) / (tp + fn + smooth)
    specificity = (tn + smooth) / (tn + fp + smooth)
    accuracy = (tp + tn + smooth) / (tp + tn + fp + fn + smooth)

    return {
        "iou": float(iou),
        "dice": float(dice),
        "precision": float(precision),
        "recall": float(recall),
        "f1": float(dice),
        "specificity": float(specificity),
        "accuracy": float(accuracy),
        "true_positives": int(tp),
        "false_positives": int(fp),
        "false_negatives": int(fn),
        "true_negatives": int(tn),
    }
