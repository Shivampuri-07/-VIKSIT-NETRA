"""
Regression tests for the changes that make real-data work practical:
  * ml/data_root.py            configurable external data root (AEGIS_DATA_ROOT), no hard-coded user path
  * ml/datasets/dataset.py     scene cache: bit-identical to the original full-read path
  * ml/metrics/evaluation.py   NumPy fast path: exactly equal to the list implementation
Fixtures are generated arrays / temporary GeoTIFFs, never SAR data.
"""
import os
import sys
import tempfile
import unittest

import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.dirname(__file__))
import _fixtures_dataset as fx  # noqa: E402
from ml import data_root as dr  # noqa: E402

try:
    import rasterio
    import torch  # noqa: F401
    HAVE_RIO_TORCH = True
except ImportError:  # pragma: no cover
    HAVE_RIO_TORCH = False


class TestDataRoot(unittest.TestCase):
    def setUp(self):
        self._old = os.environ.get("AEGIS_DATA_ROOT")

    def tearDown(self):
        if self._old is None:
            os.environ.pop("AEGIS_DATA_ROOT", None)
        else:
            os.environ["AEGIS_DATA_ROOT"] = self._old

    def test_unset_or_missing_root_falls_back_to_project(self):
        os.environ["AEGIS_DATA_ROOT"] = os.path.join(tempfile.gettempdir(), "definitely_missing_aegis_root")
        self.assertIsNone(dr.data_root())
        self.assertEqual(str(dr.radar_dataset_root()), str(dr.PROJECT_ROOT / dr.RADAR_REL))

    def test_external_root_wins_and_Data_case_is_tolerated(self):
        with tempfile.TemporaryDirectory() as t:
            os.makedirs(os.path.join(t, "Data", "ais"))
            open(os.path.join(t, "Data", "ais", "x.csv"), "w").write("a\n")
            os.environ["AEGIS_DATA_ROOT"] = t
            self.assertEqual(str(dr.data_root()), t)
            found = dr.resolve_data("data", "ais", "x.csv")     # asked with lower-case "data"
            self.assertIsNotNone(found)
            self.assertTrue(str(found).startswith(t))
            self.assertIsNone(dr.resolve_data("data", "ais", "does_not_exist.csv"))

    def test_source_has_no_user_specific_path(self):
        for f in ("ml/data_root.py", "server/lib/dataroot.ts"):
            src = open(os.path.join(ROOT, f)).read()
            self.assertNotIn("/Users/", src)
            self.assertNotIn("satyampuri", src)


class TestMetricsFastPath(unittest.TestCase):
    def test_numpy_path_equals_list_path(self):
        from ml.metrics.evaluation import calculate_metrics
        rng = np.random.default_rng(3)
        for _ in range(4):
            p = rng.random((2, 1, 32, 32)) > 0.6
            t = rng.random((2, 1, 32, 32)) > 0.5
            self.assertEqual(calculate_metrics(p.astype(np.float32), t.astype(np.float32)),
                             calculate_metrics(p.astype(int).ravel().tolist(), t.astype(int).ravel().tolist()))


@unittest.skipUnless(HAVE_RIO_TORCH, "needs rasterio + torch")
class TestDatasetCache(unittest.TestCase):
    def test_cached_loader_is_bit_identical_to_a_fresh_read(self):
        from ml.datasets.dataset import SAROilSpillDataset as D
        for norm in ("patch", "scene"):
            with tempfile.TemporaryDirectory() as t:
                fx.build(t, geotiff=True)
                ds = D(t, "train", normalization=norm)
                for i in range(len(ds)):
                    s = ds.samples[i]
                    with rasterio.open(s["image"]) as a:
                        img = a.read(1).astype(np.float32)
                    with rasterio.open(s["mask"]) as a:
                        msk = a.read(1).astype(np.float32)
                    if norm == "scene":
                        img = D._zscore(img)
                    ip, mp = D._extract_patch(img, msk, s["coord_a"], s["coord_b"], 256)
                    if norm == "patch":
                        ip = D._zscore(ip)
                    ip = np.nan_to_num(ip, nan=0.0, posinf=0.0, neginf=0.0)
                    mp = (mp > 0.5).astype(np.float32)
                    x, y = ds[i]
                    self.assertTrue(np.array_equal(x.numpy()[0], ip), f"{norm} image differs at {i}")
                    self.assertTrue(np.array_equal(y.numpy()[0], mp), f"{norm} mask differs at {i}")
                    x2, _ = ds[i]                                   # second call is served from the cache
                    self.assertTrue(np.array_equal(x2.numpy(), x.numpy()))


if __name__ == "__main__":
    unittest.main()
