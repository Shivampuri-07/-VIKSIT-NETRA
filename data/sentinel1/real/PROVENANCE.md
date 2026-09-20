# `2018_09_26.tif` — demo-scene SAR raster

Sentinel-1A VV backscatter, the held-out test scene of the Zenodo 4672426 oil-spill dataset. This is
the raster that produced the stored `MODEL_PREDICTION` polygons in
`ml/results/inference/2018_09_26/unet_geometry_scene.json`, and the one the live verification
endpoint (`POST /api/demo/verify-inference`) re-runs the frozen U-Net over.

| Property | Value |
| --- | --- |
| Shape | 5083 × 2555 px, 1 band |
| Dtype | float32 |
| CRS | EPSG:32616 (UTM 16N) |
| Pixel size | 10 m |
| Value range | −36.450325 to +20.961740 (sigma0, dB) |
| Footprint | −89.42513, 28.77146, −88.8994, 29.01027 (WGS84) |

## The only change made for deployment

The file was **recompressed, not resampled**: DEFLATE with a horizontal float predictor, 256 px tiles.

* Source: 51,969,263 bytes, uncompressed
* Bundled: 34,601,803 bytes, DEFLATE
* **Pixel values are bit-identical** — verified with `numpy.array_equal` against the source raster.

No cropping, no rescaling, no reprojection, no 8-bit conversion, and nothing was drawn into the
image. The live U-Net run over this file reproduces the stored prediction exactly (534,549 positive
pixels in both), which is the check the Verify-detection panel performs and displays.

Because the bytes changed, the file's SHA-256 is **not** the one recorded in
`unet_geometry_scene.json → source_raster.sha256`
(`eb382bb498d51ae6d4f4b8d0c3dc4dd15ba6137290eb5ca4a473c4b60a2e685a`). That hash describes the
original uncompressed source. Equivalence here is established by pixel comparison and by the
reproduced prediction, not by file hash.

Regenerate from the source raster with:

```python
import rasterio, numpy as np
with rasterio.open(SRC) as ds:
    profile, band = ds.profile.copy(), ds.read(1)
profile.update(compress="deflate", predictor=3, zlevel=9,
               tiled=True, blockxsize=256, blockysize=256)
with rasterio.open(DST, "w", **profile) as dst:
    dst.write(band, 1)
```
