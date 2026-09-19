"""
Extension points for advanced AEGIS intelligence.

Status truth lives in ml/extensions/capabilities.json. Only classes backed by
a verified implementation produce outputs; every other class raises
NotAvailableError naming the data/model it needs. There are NO placeholder
networks, predictions, confidence scores or training results here.
"""
from __future__ import annotations

import json
import os
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

_CAPS = os.path.join(os.path.dirname(__file__), "capabilities.json")


class NotAvailableError(NotImplementedError):
    """Raised by extension points that have no model/data behind them."""


def _blocker(cap_id: str) -> str:
    try:
        caps = {c["id"]: c for c in json.load(open(_CAPS))["capabilities"]}
        c = caps[cap_id]
        return f"{c['name']} [{c['status']}]: {c.get('blocker') or 'no implementation'}"
    except Exception:  # pragma: no cover
        return cap_id


def _unavailable(cap_id: str):
    raise NotAvailableError(_blocker(cap_id))


# ---------------------------------------------------------------- segmentation
class SegmentationModel(ABC):
    name: str = "abstract"

    @abstractmethod
    def predict_proba(self, tile: np.ndarray) -> np.ndarray:
        """(H, W) normalised float32 tile -> (H, W) oil probabilities."""


class UNetBaselineNumpy(SegmentationModel):
    """IMPLEMENTED: the frozen production U-Net run through the verified NumPy reference (CPU, slow)."""
    name = "unet_baseline@33688d9b"

    def __init__(self, checkpoint: Optional[str] = None):
        from ml.verification.numpy_reference import read_torch_checkpoint
        root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
        self._sd = read_torch_checkpoint(checkpoint or os.path.join(root, "ml", "checkpoints", "unet_oil_spill_best.pth"))["model_state_dict"]

    def predict_proba(self, tile: np.ndarray) -> np.ndarray:
        from ml.verification.numpy_reference import unet_forward, sigmoid
        return sigmoid(unet_forward(self._sd, np.asarray(tile, np.float32)[None]))[0]


class SegmentationEnsemble(SegmentationModel):
    """Combiner (IMPLEMENTED): mean probability + member disagreement. Members beyond the baseline do not exist yet."""
    name = "ensemble"

    def __init__(self, members: Sequence[SegmentationModel], weights: Optional[Sequence[float]] = None):
        if not members:
            raise ValueError("an ensemble needs at least one member")
        self.members = list(members)
        w = np.asarray(weights if weights is not None else [1.0] * len(members), np.float64)
        if w.shape != (len(members),) or (w < 0).any() or w.sum() <= 0:
            raise ValueError("invalid weights")
        self.weights = w / w.sum()

    def predict_with_disagreement(self, tile: np.ndarray) -> Tuple[np.ndarray, np.ndarray, str]:
        preds = np.stack([m.predict_proba(tile) for m in self.members]).astype(np.float64)
        mean = np.tensordot(self.weights, preds, axes=1)
        std = np.sqrt(np.tensordot(self.weights, (preds - mean) ** 2, axes=1))
        note = "single member: disagreement is 0 by construction (no ensemble uncertainty)" if len(self.members) == 1 else f"{len(self.members)} members"
        return mean.astype(np.float32), std.astype(np.float32), note

    def predict_proba(self, tile: np.ndarray) -> np.ndarray:
        return self.predict_with_disagreement(tile)[0]


class UNetPlusPlus(SegmentationModel):
    def __init__(self, *a, **k): _unavailable("seg_ensemble")
    def predict_proba(self, tile): _unavailable("seg_ensemble")


class DeepLabV3Plus(UNetPlusPlus):
    pass


class SegFormer(UNetPlusPlus):
    pass


class SSLSAREncoder:
    def __init__(self, *a, **k): _unavailable("sar_ssl")


class LookAlikeClassifier:
    def __init__(self, *a, **k): _unavailable("lookalike")


class BayesianSegmentationUncertainty:
    def __init__(self, *a, **k): _unavailable("bayes_uncertainty")


# ---------------------------------------------------------------- drift / ocean / AIS / fusion
class LearnedDriftCorrection:
    """Extension point. The physical Lagrangian model stays authoritative unless a candidate passes the gate."""

    def __init__(self, *a, **k): _unavailable("drift_learned")

    @staticmethod
    def validation_gate(baseline_errors_km: Sequence[float], candidate_errors_km: Sequence[float],
                        min_cases: int = 20, min_relative_improvement: float = 0.1) -> Dict[str, object]:
        """IMPLEMENTED rule: accept a learned correction only on held-out cases, with enough cases and a
        clear improvement of the median separation error over the physics baseline."""
        b, c = np.asarray(baseline_errors_km, float), np.asarray(candidate_errors_km, float)
        if b.shape != c.shape or b.size < min_cases:
            return {"accepted": False, "reason": f"need >= {min_cases} paired held-out cases (got {min(b.size, c.size)})"}
        mb, mc = float(np.median(b)), float(np.median(c))
        worse = float(np.mean(c > b))
        ok = mc <= (1 - min_relative_improvement) * mb and worse < 0.5
        return {"accepted": bool(ok), "median_baseline_km": mb, "median_candidate_km": mc, "fraction_cases_worse": worse,
                "reason": "passes gate" if ok else "does not improve the physics baseline enough"}


class OceanFieldPredictor:
    def __init__(self, *a, **k): _unavailable("ocean_forecast")


class TrajectoryModel:
    def __init__(self, *a, **k): _unavailable("ais_sequence")


class VesselRelationGNN:
    def __init__(self, *a, **k): _unavailable("vessel_gnn")


class MultimodalFusion:
    def __init__(self, *a, **k): _unavailable("multimodal_fusion")


class ProbabilisticAttributionModel:
    def __init__(self, *a, **k): _unavailable("prob_attribution")


class DomainAdapter:
    def __init__(self, *a, **k): _unavailable("domain_adaptation")


class MultiSatelliteValidator:
    def __init__(self, *a, **k): _unavailable("multi_satellite")


# ---------------------------------------------------------------- learning loop
@dataclass
class FeedbackRecord:
    """Investigator feedback (same fields as server/lib/review.ts). Unverified input, never auto-labelled ground truth."""
    investigation_id: str
    target: str
    verdict: str
    mmsi: Optional[str] = None
    hypothesis_id: Optional[str] = None
    note: Optional[str] = None
    status: str = "UNVERIFIED_INVESTIGATOR_INPUT"

    def validate(self) -> List[str]:
        errs = []
        if self.target not in ("detection", "vessel", "hypothesis"):
            errs.append("target")
        if self.verdict not in ("confirmed", "rejected", "uncertain"):
            errs.append("verdict")
        if self.target == "vessel" and not (self.mmsi and self.mmsi.isdigit()):
            errs.append("mmsi")
        return errs


@dataclass
class ActiveLearningQueue:
    """IMPLEMENTED (rule-based): orders cases by transparent review signals; trains nothing."""
    weights: Dict[str, float] = field(default_factory=lambda: {
        "uncertainty_high": 0.3, "lookalike_risk": 0.25, "close_ranking": 0.2, "unstable_rank": 0.1,
        "no_current": 0.1, "approximate_outline": 0.05, "model_disagreement": 0.3})
    _items: List[Tuple[float, str, List[str]]] = field(default_factory=list)

    def add(self, case_id: str, signals: Dict[str, bool]) -> float:
        unknown = set(signals) - set(self.weights)
        if unknown:
            raise KeyError(f"unknown signals {sorted(unknown)}")
        on = [k for k, v in signals.items() if v]
        score = min(1.0, sum(self.weights[k] for k in on))
        self._items.append((score, case_id, on))
        return score

    def top(self, n: int = 10) -> List[Tuple[float, str, List[str]]]:
        return sorted(self._items, key=lambda x: (-x[0], x[1]))[:n]
