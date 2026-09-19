"""Promotion-rule logic (ml/evaluation/compare_candidate.py). Synthetic report dicts, no model, no data."""
import copy
import os
import sys
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, ROOT)
from ml.evaluation.compare_candidate import decide  # noqa: E402


def report(macro=0.46, pooled=0.47, fa=0, ece=0.04, brier=0.04):
    proto = lambda: {"macro_mean": {"dice": macro, "pixel_false_positive_rate": 0.03}, "pooled": {"dice": pooled},
                     "false_alarm_scenes": fa, "calibration": {"ece": ece, "brier": brier},
                     "per_scene": [{"scene": "a.tif", "dice": macro}, {"scene": "b.tif", "dice": macro}]}
    return {"scene_overlap_protocol": proto(), "historic_protocol": proto(), "patch_overlap_protocol": proto(),
            "checkpoint": {"sha256": "x"}, "frozen_baseline_unchanged": True}


class TestPromotionRule(unittest.TestCase):
    def test_everything_better_recommends_but_never_promotes(self):
        d = decide(report(), report(macro=0.5, pooled=0.5, ece=0.03, brier=0.03))
        self.assertEqual(d["decision"], "PROMOTE_RECOMMENDED")
        self.assertFalse(d["promoted"])

    def test_any_single_failed_criterion_keeps_the_baseline(self):
        good = dict(macro=0.5, pooled=0.5, ece=0.03, brier=0.03)
        for bad in ({"macro": 0.4}, {"pooled": 0.4}, {"fa": 1}, {"ece": 0.06}, {"brier": 0.06}):
            d = decide(report(), report(**{**good, **bad}))
            self.assertEqual(d["decision"], "KEEP_BASELINE", bad)
            self.assertFalse(d["promoted"])

    def test_equal_performance_is_not_an_improvement(self):
        self.assertEqual(decide(report(), copy.deepcopy(report()))["decision"], "KEEP_BASELINE")


if __name__ == "__main__":
    unittest.main()
