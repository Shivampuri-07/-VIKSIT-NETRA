"""
Builds a tiny TEST-ONLY dataset in the exact layout ml/datasets/dataset.py and
ml/training/run_guard.py expect. Generated arrays, not SAR data, never used
for training. Rasters are written with rasterio when available; otherwise as
.npy payloads read back by the test stub.
"""
import os
import numpy as np

H, W = 600, 700


def _write(path, arr, real_rasterio, geo=None):
    if real_rasterio is not None:
        kw = dict(driver="GTiff", height=arr.shape[0], width=arr.shape[1], count=1, dtype=str(arr.dtype))
        if geo:
            kw.update(geo)
        with real_rasterio.open(path, "w", **kw) as dst:
            dst.write(arr, 1)
    else:
        with open(path, "wb") as f:
            np.save(f, arr)


def build(root, real_rasterio=None, leak=False, geotiff=False):
    """
    geotiff=True writes VALID, georeferenced GeoTIFFs (EPSG:32616, 10 m) with the real rasterio, so subprocesses that
    use real rasterio (e.g. `train.py --dry-run`) can read them. Without it (default) rasters are .npy payloads read
    back by the in-process test stub. Still generated arrays only, never SAR data, never used for training.
    """
    geo = None
    if geotiff:
        import rasterio as _rio
        from rasterio.transform import from_origin
        real_rasterio = _rio
        geo = {"crs": "EPSG:32616", "transform": from_origin(500000.0, 3200000.0, 10.0, 10.0)}
    img = (np.arange(H)[:, None] * 1000 + np.arange(W)[None, :]).astype(np.float32)  # value encodes (row, col)
    m01 = np.zeros((H, W), np.float32); m01[100:200, 200:300] = 1
    m255 = np.zeros((H, W), np.uint8); m255[300:350, 400:500] = 255
    for sub in ("train/images", "train/masks", "test/images", "test/masks"):
        os.makedirs(os.path.join(root, sub), exist_ok=True)
    for name, mask in (("scene_a.tif", m01), ("scene_b.tif", m255), ("scene_c.tif", m01)):
        _write(os.path.join(root, "train/images", name), img, real_rasterio, geo)
        _write(os.path.join(root, "train/masks", name), mask, real_rasterio, geo)
    _write(os.path.join(root, "test/images", "scene_t.tif"), img, real_rasterio, geo)
    _write(os.path.join(root, "test/masks", "scene_t.tif"), m01, real_rasterio, geo)
    train_rows = [(r"C:\data\Radar_data\train\images\scene_a.tif", "300,350", 1),
                  (r"C:\data\Radar_data\train\images\scene_b.tif", "5,690", 0),
                  (r"C:\data\Radar_data\train\images\scene_b.tif", "320,450", 1)]  # covers the 0/255 mask block
    val_rows = [(r"C:\data\Radar_data\train\images\scene_c.tif", "150,250", 1)]
    if leak:
        val_rows.append((r"C:\data\Radar_data\train\images\scene_a.tif", "450,450", 0))
    for fname, rows in (("dataframe_train_dataset_256_90.csv", train_rows), ("dataframe_val_dataset_256_90.csv", val_rows)):
        with open(os.path.join(root, "train", fname), "w") as f:
            f.write("paths,coordinates,class\n")
            for p, c, k in rows:
                f.write(f'"{p}","{c}",{k}\n')
    return img
