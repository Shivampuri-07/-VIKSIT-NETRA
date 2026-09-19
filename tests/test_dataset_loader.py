"""
Dataset loader tests for ml/datasets/dataset.py.

Uses real torch + rasterio when installed. Otherwise minimal stand-ins are
injected ONLY while dataset.py is imported (unittest.mock.patch.dict), so they
cannot leak into other tests. With stand-ins, the loader's own logic is
verified (CSV parsing, Windows paths, patch placement/clamping, normalisation,
mask binarisation, shapes, error handling); real GeoTIFF I/O is not.
"""
import importlib
import os
import sys
import tempfile
import types
import unittest

import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.dirname(__file__))
import _fixtures_dataset as fx  # noqa: E402

try:
    import torch as _torch  # noqa: F401
    import rasterio as _rio
    REAL = True
except ImportError:
    _rio = None
    REAL = False


def _stub_modules():
    rio = types.ModuleType("rasterio")

    class _Src:
        def __init__(self, p): self.p = p
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self, band):
            assert band == 1
            with open(self.p, "rb") as f:
                return np.load(f)
    rio.open = lambda p, *a, **k: _Src(p)

    class _T:
        def __init__(self, a): self.a = a
        def float(self): return np.asarray(self.a, dtype=np.float32)
    torch = types.ModuleType("torch")
    torch.from_numpy = lambda a: _T(a)
    utils = types.ModuleType("torch.utils"); data = types.ModuleType("torch.utils.data")
    data.Dataset = object
    torch.utils = utils; utils.data = data
    return {"rasterio": rio, "torch": torch, "torch.utils": utils, "torch.utils.data": data}


def load_dataset_module():
    if REAL:
        return importlib.import_module("ml.datasets.dataset")
    # Insert the stand-ins, import, then remove ONLY the stand-in keys. (patch.dict would also
    # evict real modules first imported during the import, e.g. pandas internals, and break them.)
    import pandas  # noqa: F401  ensure real dependencies are loaded outside the stub window
    stubs = _stub_modules()
    saved = {k: sys.modules.get(k) for k in stubs}
    sys.modules.update(stubs)
    try:
        sys.modules.pop("ml.datasets.dataset", None)
        return importlib.import_module("ml.datasets.dataset")
    finally:
        for k, v in saved.items():
            if v is None:
                sys.modules.pop(k, None)
            else:
                sys.modules[k] = v


def arr(x):
    return x.numpy() if hasattr(x, "numpy") else np.asarray(x)


class TestDatasetLoader(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = load_dataset_module()
        cls.tmp = tempfile.TemporaryDirectory()
        cls.root = cls.tmp.name
        cls.img = fx.build(cls.root, _rio)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def ds(self, split, normalize=True):
        return self.mod.SAROilSpillDataset(self.root, split=split, normalize=normalize)

    def test_module_compiles_and_class_complete(self):
        for name in ("_read_tif", "_extract_patch", "__len__", "__getitem__", "_build_csv_samples", "_build_test_samples"):
            self.assertTrue(hasattr(self.mod.SAROilSpillDataset, name), name)

    def test_train_split_shapes_and_windows_paths(self):
        d = self.ds("train")
        self.assertEqual(len(d), 3)
        image, mask = d[0]
        self.assertEqual(arr(image).shape, (1, 256, 256))
        self.assertEqual(arr(mask).shape, (1, 256, 256))
        self.assertEqual(d.samples[0]["image"].name, "scene_a.tif")  # Windows path reduced to file name

    def test_patch_placement_centre_row_col(self):
        image, mask = self.ds("train", normalize=False)[0]         # coordinates "300,350"
        a = arr(image)[0]
        self.assertEqual(a[0, 0], (300 - 128) * 1000 + (350 - 128))   # top-left = centre - 128
        self.assertEqual(a[255, 255], (300 + 127) * 1000 + (350 + 127))

    def test_patch_clamped_inside_raster(self):
        image, _ = self.ds("train", normalize=False)[1]             # coordinates "5,690" near the corner
        a = arr(image)[0]
        self.assertEqual(a[0, 0], 0 * 1000 + (fx.W - 256))

    def test_normalisation_per_patch(self):
        image, _ = self.ds("train")[0]
        a = arr(image)[0]
        self.assertAlmostEqual(float(a.mean()), 0.0, places=4)
        self.assertAlmostEqual(float(a.std()), 1.0, places=3)

    def test_mask_binarised_for_0_1_and_0_255(self):
        # 0/1 mask, patch centred (300,350) -> rows 172-427, cols 222-477; block rows 100-199 x cols 200-299
        _, m = self.ds("train")[0]
        self.assertEqual(set(np.unique(arr(m))), {0.0, 1.0})
        self.assertEqual(arr(m).sum(), 28 * 78)
        # 0/255 mask, patch centred (320,450) -> rows 192-447, cols 322-577; block rows 300-349 x cols 400-499 fully inside
        _, m255 = self.ds("train")[2]
        self.assertEqual(set(np.unique(arr(m255))), {0.0, 1.0})
        self.assertEqual(arr(m255).sum(), 50 * 100)
        # val sample centred (150,250) -> rows 22-277, cols 122-377; 0/1 block fully inside
        _, mv = self.ds("val")[0]
        self.assertEqual(arr(mv).sum(), 100 * 100)

    def test_scene_normalisation_option(self):
        d = self.mod.SAROilSpillDataset(self.root, split="train", normalization="scene")
        image, _ = d[0]
        scene = self.img
        z = (scene - scene.mean()) / (scene.std() + 1e-6)
        expected = z[172:428, 222:478]                                # patch centred (300,350)
        self.assertTrue(np.allclose(arr(image)[0], expected, atol=1e-4))
        with self.assertRaises(ValueError):
            self.mod.SAROilSpillDataset(self.root, split="train", normalization="bogus")

    def test_test_split_full_scene(self):
        image, mask = self.ds("test")[0]
        self.assertEqual(arr(image).shape, (1, fx.H, fx.W))
        self.assertEqual(arr(mask).shape, (1, fx.H, fx.W))

    def test_errors(self):
        with tempfile.TemporaryDirectory() as t:
            fx.build(t, _rio)
            p = os.path.join(t, "train", "dataframe_train_dataset_256_90.csv")
            open(p, "w").write('paths,coordinates,class\n"C:\\\\x\\\\missing.tif","1,2",1\n')
            with self.assertRaises(FileNotFoundError):
                self.mod.SAROilSpillDataset(t, split="train")
            open(p, "w").write('paths,coords,class\n"a.tif","1,2",1\n')
            with self.assertRaises(ValueError):
                self.mod.SAROilSpillDataset(t, split="train")
            open(p, "w").write('paths,coordinates,class\n"C:\\\\x\\\\scene_a.tif","abc",1\n')
            with self.assertRaises(ValueError):
                self.mod.SAROilSpillDataset(t, split="train")
        with self.assertRaises(ValueError):
            self.mod.SAROilSpillDataset(self.root, split="bogus")


if __name__ == "__main__":
    unittest.main()
