"""
Baseline integrity: the production checkpoint and its recorded results are
unchanged, structurally consistent with ml/models/unet.py, and an independent
NumPy re-implementation reproduces a stored PyTorch inference.
Set AEGIS_SKIP_SLOW=1 to skip the ~20 s reproduction.
"""
import json
import os
import sys
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, ROOT)
from ml.verification import verify_baseline as vb  # noqa: E402

BASELINE_SHA = "33688d9b6148f792ec9900f881b6241468c0915080808bd3f5458259edde24af"


class TestBaselineIntegrity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest = json.load(open(vb.MANIFEST))
        cls.registry = json.load(open(os.path.join(ROOT, "ml", "model_registry.json")))
        cls.struct, cls.sd = vb.structure_check()

    def test_checkpoint_hash_and_size(self):
        self.assertEqual(vb.sha256(vb.CHECKPOINT), BASELINE_SHA)
        self.assertEqual(self.manifest["checkpoint"]["sha256"], BASELINE_SHA)
        self.assertEqual(os.path.getsize(os.path.join(ROOT, vb.CHECKPOINT)), 17329363)

    def test_all_frozen_artifacts_unchanged(self):
        for p, h in self.manifest["artifacts_sha256"].items():
            with self.subTest(p):
                if p.startswith(vb.OPTIONAL_PREFIXES) and not os.path.exists(os.path.join(ROOT, p)):
                    continue  # optional visual-only file not distributed via Git
                self.assertEqual(vb.sha256(p), h)

    def test_structure_matches_architecture(self):
        self.assertTrue(self.struct["keys_match"] and self.struct["shapes_match"])
        self.assertEqual(self.struct["n_tensors"], 110)
        self.assertEqual(self.struct["n_parameters"], 4322241)

    def test_metadata_registry_manifest_agree(self):
        meta = self.struct["metadata"]
        reg = self.registry["models"][0]
        self.assertEqual(meta["epoch"], 3)
        self.assertEqual(reg["checkpoint"]["epoch"], meta["epoch"])
        self.assertAlmostEqual(reg["validation_metrics"]["dice"], meta["val_dice"], places=12)
        tm = json.load(open(os.path.join(ROOT, "ml", "results", "test_metrics.json")))
        self.assertEqual(self.manifest["recorded_test_metrics"]["mean_dice"], tm["mean_dice"])
        self.assertEqual(reg["test_metrics"]["mean_dice"], tm["mean_dice"])

    def test_registry_threshold_attribution_corrected(self):
        reg = self.registry["models"][0]
        self.assertNotIn("inference_threshold", reg["hyperparameters"])
        self.assertEqual(reg["evaluation_protocol"]["threshold"], 0.5)
        self.assertIn("0.48", reg["inference_paths"]["ml/inference/segmenter.py"])

    @unittest.skipIf(os.environ.get("AEGIS_SKIP_SLOW") == "1", "slow reproduction skipped")
    def test_numpy_reproduces_stored_pytorch_inference(self):
        r = vb.reproduce(self.sd)
        self.assertTrue(r["passed"], r)
        self.assertLess(r["max_abs_diff"], 1e-6)
        self.assertLess(r["max_rel_diff"], 1e-3)
        self.assertEqual(r["pixels_ge_0_5_numpy"], r["pixels_ge_0_5_stored"])


if __name__ == "__main__":
    unittest.main()
