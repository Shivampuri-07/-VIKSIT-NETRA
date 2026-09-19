from pathlib import Path
import xml.etree.ElementTree as ET

import numpy as np
import rasterio


ROOT = Path("data/sentinel1/extracted")
SAFE = next(ROOT.glob("*.SAFE"))

VV_TIFF = next(SAFE.glob("measurement/*vv*.tiff"))
CAL_XML = next(SAFE.glob("annotation/calibration/calibration-*vv*.xml"))

OUT = Path("data/sentinel1/S1A_20250704_VV_sigma0_db.tif")


def get_tag(elem):
    return elem.tag.split("}")[-1]


def read_calibration_vectors(xml_path):
    root = ET.parse(xml_path).getroot()

    vectors = []

    for cv in root.iter():
        if get_tag(cv) != "calibrationVector":
            continue

        line = None
        pixels = None
        sigma = None

        for child in cv:
            tag = get_tag(child)

            if tag == "line":
                line = int(child.text.strip())

            elif tag == "pixel":
                pixels = np.asarray(
                    child.text.strip().split(),
                    dtype=np.float64
                )

            elif tag == "sigmaNought":
                sigma = np.asarray(
                    child.text.strip().split(),
                    dtype=np.float64
                )

        if line is not None and pixels is not None and sigma is not None:
            vectors.append((line, pixels, sigma))

    vectors.sort(key=lambda x: x[0])
    return vectors


print("VV:", VV_TIFF)
print("Calibration:", CAL_XML)

vectors = read_calibration_vectors(CAL_XML)

print("Calibration vectors:", len(vectors))
print("Pixels per vector:", len(vectors[0][1]))

with rasterio.open(VV_TIFF) as src:
    profile = src.profile.copy()
    height = src.height
    width = src.width

    # Process row-by-row in blocks to avoid huge RAM usage.
    profile.update(
        dtype="float32",
        count=1,
        compress="deflate",
        predictor=3,
        nodata=-9999.0,
    )

    with rasterio.open(OUT, "w", **profile) as dst:

        for row in range(height):

            dn = src.read(1, window=((row, row + 1), (0, width))).astype(
                np.float64
            )[0]

            # Find surrounding calibration vectors.
            lines = np.array([v[0] for v in vectors], dtype=np.float64)

            if row <= lines[0]:
                lo = hi = 0
            elif row >= lines[-1]:
                lo = hi = len(lines) - 1
            else:
                hi = np.searchsorted(lines, row)
                lo = hi - 1

            def calibration_at(idx):
                _, px, sig = vectors[idx]
                return np.interp(
                    np.arange(width),
                    px,
                    sig
                )

            sigma_lo = calibration_at(lo)

            if lo == hi:
                sigma = sigma_lo
            else:
                sigma_hi = calibration_at(hi)

                alpha = (
                    (row - lines[lo]) /
                    (lines[hi] - lines[lo])
                )

                sigma = sigma_lo + alpha * (sigma_hi - sigma_lo)

            # Sentinel-1 GRD calibration:
            # sigma0 = DN^2 / calibration_factor
            sigma0 = np.where(
                sigma > 0,
                (dn ** 2) / sigma,
                np.nan
            )

            # Convert linear sigma0 to dB.
            db = 10.0 * np.log10(
                np.maximum(sigma0, 1e-12)
            )

            db[~np.isfinite(db)] = -9999.0

            dst.write(
                db.astype(np.float32)[None, :],
                1,
                window=((row, row + 1), (0, width))
            )

            if row % 1000 == 0:
                print(f"Processed {row}/{height} rows")

print("\nDONE")
print("Output:", OUT)
