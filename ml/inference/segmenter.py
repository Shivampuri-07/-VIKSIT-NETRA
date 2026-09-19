"""
SAR Oil Spill Segmentation & Inference Pipeline.

Runs the trained U-Net model when available and falls back to
adaptive SAR dark-formation segmentation when the model is unavailable.

The public inference API exposes both:
    segment(...)
    predict(...)

so existing pipeline code can use either interface.
"""

from pathlib import Path
from typing import Dict, Any, Tuple, Optional

try:
    import numpy as np
    HAS_NUMPY = True
except ImportError:
    HAS_NUMPY = False

try:
    import torch
    from ml.models.unet import SAROilSpillUNet, get_device
    HAS_TORCH = True
except ImportError:
    HAS_TORCH = False


class OilSpillSegmenter:
    """
    Handles model loading, inference, thresholding, and fallback
    SAR segmentation.
    """

    def __init__(
        self,
        model_path: Optional[str] = None,
        threshold: float = 0.5,  # aligned with the evaluated baseline (test_model.py); 0.48 had no calibration evidence
    ):
        self.threshold = threshold
        self.model = None
        self.device = None
        self.model_path = model_path
        self.load_error = None

        if HAS_TORCH:
            try:
                self.device = get_device()

                self.model = SAROilSpillUNet(
                    in_channels=1,
                    num_classes=1,
                ).to(self.device)

                if model_path:
                    state_dict = torch.load(
                        Path(model_path),
                        map_location=self.device,
                    )

                    if (
                        isinstance(state_dict, dict)
                        and "model_state_dict" in state_dict
                    ):
                        state_dict = state_dict["model_state_dict"]

                    self.model.load_state_dict(state_dict)

                self.model.eval()

            except Exception as exc:
                self.load_error = str(exc)
                self.model = None

    def segment(
        self,
        sar_image: Any,
    ) -> Tuple[Any, Any, float]:
        """
        Segment a SAR raster.

        Returns:
            mask
            probability_map
            confidence
        """

        # ---------------------------------------------------------
        # 1. Trained U-Net inference
        # ---------------------------------------------------------
        if (
            HAS_TORCH
            and self.model is not None
            and HAS_NUMPY
            and isinstance(sar_image, np.ndarray)
        ):
            img = np.asarray(sar_image, dtype=np.float32)

            # Replace invalid pixels so PyTorch does not receive NaN/Inf.
            if not np.isfinite(img).all():
                finite = img[np.isfinite(img)]

                if finite.size:
                    replacement = float(np.median(finite))
                else:
                    replacement = 0.0

                img = np.nan_to_num(
                    img,
                    nan=replacement,
                    posinf=replacement,
                    neginf=replacement,
                )

            img_tensor = (
                torch.from_numpy(img)
                .float()
                .unsqueeze(0)
                .unsqueeze(0)
                .to(self.device)
            )

            with torch.no_grad():
                logits = self.model(img_tensor)
                probs = (
                    torch.sigmoid(logits)
                    .squeeze()
                    .detach()
                    .cpu()
                    .numpy()
                )

            mask = (
                probs >= self.threshold
            ).astype(np.uint8)

            spill_pixels = mask == 1

            if np.any(spill_pixels):
                mean_prob = float(
                    np.mean(probs[spill_pixels])
                )
                confidence = min(
                    0.96,
                    max(0.60, mean_prob * 1.05),
                )
            else:
                mean_prob = 0.0
                confidence = 0.0

            return mask, probs, confidence

        # ---------------------------------------------------------
        # 2. NumPy adaptive fallback
        # ---------------------------------------------------------
        if HAS_NUMPY and isinstance(sar_image, np.ndarray):
            img = np.asarray(sar_image, dtype=np.float32)

            finite = img[np.isfinite(img)]

            if finite.size == 0:
                mask = np.zeros_like(img, dtype=np.uint8)
                probs = np.zeros_like(img, dtype=np.float32)
                return mask, probs, 0.0

            mean_val = float(np.mean(finite))
            std_val = float(np.std(finite))

            dark_thresh = mean_val - 0.85 * std_val

            # Normalize dark SAR formations into a simple
            # probability-like score.
            denominator = abs(mean_val) + 1e-6

            prob_map = np.clip(
                1.0 - (img / denominator),
                0.0,
                1.0,
            ).astype(np.float32)

            mask = (
                img < dark_thresh
            ).astype(np.uint8)

            spill_pixels = mask == 1

            if np.any(spill_pixels):
                mean_prob = float(
                    np.mean(prob_map[spill_pixels])
                )
                confidence = min(
                    0.96,
                    max(0.60, mean_prob * 1.05),
                )
            else:
                mean_prob = 0.0
                confidence = 0.0

            return mask, prob_map, confidence

        # ---------------------------------------------------------
        # 3. Pure Python 2D-list fallback
        # ---------------------------------------------------------
        h = len(sar_image)

        if h == 0:
            return [], [], 0.0

        w = len(sar_image[0])

        all_vals = [
            sar_image[r][c]
            for r in range(h)
            for c in range(w)
        ]

        mean_val = (
            sum(all_vals) / len(all_vals)
            if all_vals
            else 0.5
        )

        mask = []
        probs = []
        detected_probs = []

        for r in range(h):
            mask_row = []
            prob_row = []

            for c in range(w):
                value = sar_image[r][c]

                probability = max(
                    0.0,
                    min(
                        1.0,
                        1.0 - (
                            value /
                            (mean_val + 1e-6)
                        ),
                    ),
                )

                is_spill = (
                    1
                    if probability >= self.threshold
                    else 0
                )

                if is_spill:
                    detected_probs.append(
                        probability
                    )

                mask_row.append(is_spill)
                prob_row.append(probability)

            mask.append(mask_row)
            probs.append(prob_row)

        if detected_probs:
            mean_prob = (
                sum(detected_probs)
                / len(detected_probs)
            )

            confidence = min(
                0.96,
                max(0.60, mean_prob * 1.05),
            )
        else:
            confidence = 0.0

        return mask, probs, confidence

    def predict(
        self,
        sar_image: Any,
        *args,
        **kwargs,
    ) -> Dict[str, Any]:
        """
        Compatibility wrapper used by pipeline_service.py.

        Returns a dictionary containing the segmentation mask,
        probability map, and confidence.
        """

        # Allow the service to override the threshold if supplied.
        threshold = kwargs.get("threshold")

        original_threshold = self.threshold

        if threshold is not None:
            self.threshold = float(threshold)

        try:
            mask, probabilities, confidence = self.segment(
                sar_image
            )
        finally:
            self.threshold = original_threshold

        return {
            "mask": mask,
            "probability": probabilities,
            "probabilities": probabilities,
            "confidence": float(confidence),
        }
