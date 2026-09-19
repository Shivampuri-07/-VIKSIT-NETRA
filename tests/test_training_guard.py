"""
Training guard tests: the production baseline can never be written by
training, outputs stay in ml/checkpoints/candidates/, dry-run writes nothing.
"""
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.dirname(__file__))
import _fixtures_dataset as fx  # noqa: E402
from ml.training import run_guard as g  # noqa: E402

PROD = os.path.join(ROOT, "ml", "checkpoints", "unet_oil_spill_best.pth")
BASELINE_SHA = "33688d9b6148f792ec9900f881b6241468c0915080808bd3f5458259edde24af"


def sha(p):
    return hashlib.sha256(open(p, "rb").read()).hexdigest()


def snapshot_checkpoints():
    out = {}
    for dp, _, fs in os.walk(os.path.join(ROOT, "ml", "checkpoints")):
        for f in fs:
            p = os.path.join(dp, f)
            out[os.path.relpath(p, ROOT)] = (os.path.getsize(p), os.path.getmtime(p))
    return out


class TestProductionProtection(unittest.TestCase):
    def test_direct_relative_and_dotdot_paths_refused(self):
        for p in (PROD, os.path.join(ROOT, "ml", "checkpoints", "..", "checkpoints", "unet_oil_spill_best.pth"),
                  os.path.relpath(PROD)):
            with self.subTest(p=p), self.assertRaises(g.ProductionCheckpointProtectedError):
                g.assert_not_production(p)

    def test_symlink_to_production_refused(self):
        with tempfile.TemporaryDirectory() as t:
            link = os.path.join(t, "innocent_name.pth")
            os.symlink(PROD, link)
            with self.assertRaises(g.ProductionCheckpointProtectedError):
                g.assert_not_production(link)

    def test_outputs_must_be_new_and_inside_candidates(self):
        with self.assertRaises(g.ProductionCheckpointProtectedError):
            g.assert_safe_candidate_output(os.path.join(tempfile.gettempdir(), "x.pth"))
        with self.assertRaises(g.ProductionCheckpointProtectedError):
            g.assert_safe_candidate_output(os.path.join(ROOT, "ml", "checkpoints", "other.pth"))
        d = g.new_candidate_run_dir("unit_test", create=False)
        self.assertTrue(str(d).startswith(str(g.CANDIDATES_ROOT)))
        self.assertFalse(d.exists())
        g.assert_safe_candidate_output(d / "candidate_best.pth")  # new file inside candidates: allowed

    def test_existing_candidate_file_not_overwritten(self):
        d = g.new_candidate_run_dir("overwrite_test")
        try:
            f = d / "candidate_best.pth"
            f.write_bytes(b"x")
            with self.assertRaises(FileExistsError):
                g.assert_safe_candidate_output(f)
        finally:
            for p in d.iterdir():
                p.unlink()
            d.rmdir()

    def test_train_py_never_targets_production(self):
        src = open(os.path.join(ROOT, "ml", "training", "train.py")).read()
        code = "\n".join(l for l in src.splitlines() if not l.strip().startswith(("#", '"', "'")) and "NEVER write" not in l)
        self.assertNotIn("unet_oil_spill_best", code.split('"""', 2)[-1])   # only mentioned in the module docstring
        saves = [m.start() for m in re.finditer(r"torch\.save\(", src)]
        self.assertEqual(len(saves), 1)
        self.assertIn("assert_not_production(save_path)", src[saves[0] - 200: saves[0]])
        self.assertIn("assert_safe_candidate_output(save_path)", src)

    def test_production_checkpoint_hash_unchanged(self):
        self.assertEqual(sha(PROD), BASELINE_SHA)
        self.assertEqual(os.path.getsize(PROD), 17329363)


class TestDryRunAndPreflight(unittest.TestCase):
    def run_cli(self, root):
        return subprocess.run([sys.executable, os.path.join(ROOT, "ml", "training", "train.py"), "--dry-run", "--dataset-root", root],
                              capture_output=True, text=True, timeout=300)

    def test_dry_run_valid_fixture_writes_nothing(self):
        before = snapshot_checkpoints()
        try:
            import rasterio  # noqa: F401
            have_rasterio = True
        except ImportError:
            have_rasterio = False
        with tempfile.TemporaryDirectory() as t:
            # The CLI runs in a SUBPROCESS with the real rasterio, so the fixture must be valid GeoTIFFs when rasterio exists
            # (the .npy stub payloads are only readable by the in-process test stub).
            fx.build(t, geotiff=have_rasterio)
            r = self.run_cli(t)
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            rep = json.loads(r.stdout[r.stdout.index("{"):])
            self.assertTrue(rep["dataset"]["ok"], rep["dataset"]["errors"])
            self.assertEqual(rep["dataset"]["splits"]["train"]["rows"], 3)
            self.assertEqual(rep["dataset"]["train_val_shared_source_images"], 0)
            self.assertEqual(rep["protected_checkpoints"][0]["sha256"], BASELINE_SHA)
        self.assertEqual(snapshot_checkpoints(), before, "dry-run must not create or modify any checkpoint file")

    def test_preflight_detects_train_val_leakage(self):
        with tempfile.TemporaryDirectory() as t:
            fx.build(t, leak=True)
            rep = g.validate_dataset_layout(t)
            self.assertTrue(rep["ok"])
            self.assertEqual(rep["train_val_shared_source_images"], 1)
            self.assertTrue(any("spatial leakage" in w for w in rep["warnings"]))

    def test_preflight_reports_missing_data(self):
        with tempfile.TemporaryDirectory() as t:
            r = self.run_cli(t)
            self.assertEqual(r.returncode, 2)
            fx.build(t)
            os.remove(os.path.join(t, "train", "images", "scene_b.tif"))
            rep = g.validate_dataset_layout(t)
            self.assertFalse(rep["ok"])
            self.assertEqual(rep["splits"]["train"]["missing_images"], 1)

    def test_training_without_torch_refuses_instead_of_faking(self):
        try:
            import torch  # noqa: F401
            self.skipTest("torch installed: real training path available")
        except ImportError:
            pass
        from ml.training import train
        with self.assertRaises(RuntimeError):
            train.train_model(epochs=1)


if __name__ == "__main__":
    unittest.main()
