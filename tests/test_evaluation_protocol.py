"""Evaluation protocol: metric/calibration correctness + tie-in to the verified baseline."""
import os, sys, unittest
import numpy as np
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..")); sys.path.insert(0, ROOT)
from ml.evaluation.protocol import confusion, metrics_from_confusion, calibration, tile_predict, evaluate_scenes, zscore  # noqa: E402


class TestMetrics(unittest.TestCase):
    def test_confusion_and_metrics(self):
        gt = np.zeros((10, 10), bool); gt[:5, :5] = True               # 25 oil px
        pr = np.zeros((10, 10), bool); pr[:5, :4] = True; pr[9, 9] = True  # 20 TP, 1 FP, 5 FN
        c = confusion(pr, gt); m = metrics_from_confusion(c)
        self.assertEqual((c["tp"], c["fp"], c["fn"], c["tn"]), (20, 1, 5, 74))
        self.assertAlmostEqual(m["dice"], 40 / 46, places=6)
        self.assertAlmostEqual(m["iou"], 20 / 26, places=6)
        self.assertAlmostEqual(m["pixel_false_positive_rate"], 1 / 75, places=6)

    def test_calibration_ece_and_brier(self):
        rng = np.random.default_rng(0)
        p = rng.uniform(0, 1, 400_000); y = rng.uniform(0, 1, p.size) < p          # perfectly calibrated
        self.assertLess(calibration(p, y)["ece"], 0.01)
        over = np.full(100_000, 0.95); y2 = rng.uniform(0, 1, over.size) < 0.5       # overconfident
        c2 = calibration(over, y2)
        self.assertAlmostEqual(c2["ece"], 0.45, delta=0.01)
        self.assertAlmostEqual(c2["brier"], 0.5 * 0.95 ** 2 + 0.5 * 0.05 ** 2, delta=0.01)

    def test_full_coverage_tiling_vs_legacy(self):
        img = np.random.default_rng(1).normal(-20, 3, (300, 530)).astype(np.float32)
        prob = tile_predict(img, lambda t: np.ones_like(t))
        self.assertTrue(np.all(prob == 1.0))                                           # every pixel predicted
        legacy = np.zeros(img.shape, int)                                              # test_model.py: stride 256, no padding
        for y in range(0, img.shape[0] - 255, 256):
            for x in range(0, img.shape[1] - 255, 256):
                legacy[y:y + 256, x:x + 256] = 1
        self.assertGreater((legacy == 0).mean(), 0.1, "legacy tiling leaves edges unscored")

    def test_normalisation_modes_differ_and_are_explicit(self):
        img = np.tile(np.linspace(-30, -10, 512, dtype=np.float32), (512, 1))
        ident = lambda t: 1 / (1 + np.exp(-t))
        a = tile_predict(img, ident, normalization="scene"); b = tile_predict(img, ident, normalization="patch")
        self.assertGreater(np.abs(a - b).max(), 0.1)
        with self.assertRaises(ValueError):
            tile_predict(img, ident, normalization="bogus")

    def test_evaluate_scenes_false_alarms(self):
        oil = np.zeros((256, 256), np.float32); oil[50:100, 50:100] = 1
        dark = np.where(oil > 0, -30.0, -15.0).astype(np.float32)
        pred = lambda t: (t < -1.0).astype(np.float32)                                  # "dark = oil" toy predictor
        clean_sea = np.full((256, 256), -15.0, np.float32); clean_sea[0:20, 0:20] = -35  # dark patch, no oil label
        r = evaluate_scenes([("s1", dark, oil), ("s2", clean_sea, np.zeros_like(oil))], pred)
        self.assertEqual(r["n_scenes"], 2)
        self.assertEqual(r["scenes_without_oil"], 1)
        self.assertEqual(r["false_alarm_scenes"], 1)
        self.assertAlmostEqual(r["per_scene"][0]["dice"], 1.0, places=6)
        self.assertIsNotNone(r["calibration"])


@unittest.skipIf(os.environ.get("AEGIS_SKIP_SLOW") == "1", "slow")
class TestProtocolAgainstVerifiedBaseline(unittest.TestCase):
    def test_protocol_tiling_reproduces_stored_pytorch_output(self):
        from ml.verification.numpy_reference import read_strip_tiff_band1
        from ml.extensions.interfaces import UNetBaselineNumpy
        img = read_strip_tiff_band1(os.path.join(ROOT, "data/sentinel1/copernicus_sigma0_test.tif"))
        ref = read_strip_tiff_band1(os.path.join(ROOT, "data/sentinel1/copernicus_oil_probability.tif")).astype(np.float64)
        prob = tile_predict(img, UNetBaselineNumpy().predict_proba, normalization="scene").astype(np.float64)
        self.assertLess(np.abs(prob - ref).max(), 1e-6)


if __name__ == "__main__":
    unittest.main()
