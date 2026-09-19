"""Labelled-data manifest validator: provenance, rejection of unlabelled/model labels, leakage."""
import os, sys, unittest
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..")); sys.path.insert(0, ROOT)
from ml.data.validate_labelled_manifest import validate  # noqa: E402

def row(sid, split, t="2024-05-01T10:00:00Z", lat=28.0, lon=-89.0, src="EMSA CleanSeaNet verified", **kw):
    r = {"scene_id": sid, "sensor": "Sentinel-1A", "polarization": "VV", "acquisition_utc": t, "lon_min": lon - 0.5, "lat_min": lat - 0.5,
         "lon_max": lon + 0.5, "lat_max": lat + 0.5, "image_path": f"{sid}.tif", "mask_path": f"{sid}_mask.tif", "label_source": src,
         "label_method": "manual polygon", "annotator": "analyst team", "license": "CC-BY-4.0", "split": split}
    r.update(kw); return {k: str(v) for k, v in r.items()}

class TestManifest(unittest.TestCase):
    def test_valid_manifest(self):
        rep = validate([row("a", "train"), row("b", "val", lat=40, lon=5), row("c", "test", t="2025-02-01T00:00:00Z", lat=10, lon=60)])
        self.assertTrue(rep["ok"], rep["errors"])
        self.assertEqual(rep["distribution"]["year"], {"2024": 2, "2025": 1})

    def test_rejects_unlabelled_and_model_generated_labels(self):
        rep = validate([row("a", "train", src="model_prediction"), row("b", "train", src="unlabelled")])
        self.assertFalse(rep["ok"]); self.assertEqual(len([e for e in rep["errors"] if "not ground truth" in e]), 2)

    def test_missing_provenance_fields(self):
        rep = validate([row("a", "train", annotator="", license="")])
        self.assertFalse(rep["ok"]); self.assertIn("missing", rep["errors"][0])

    def test_split_leakage(self):
        rep = validate([row("a", "train"), row("a", "test")])
        self.assertTrue(any("split leakage" in e for e in rep["errors"]))
        rep2 = validate([row("a", "train"), row("b", "test", t="2024-05-02T10:00:00Z", lat=28.1)])
        self.assertTrue(rep2["ok"]); self.assertTrue(any("likely the same event" in w for w in rep2["warnings"]))

if __name__ == "__main__":
    unittest.main()
