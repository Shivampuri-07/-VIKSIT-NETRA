from pathlib import Path
import xml.etree.ElementTree as ET
import numpy as np
import rasterio

ROOT = Path("data/sentinel1/extracted")
SAFE = next(ROOT.glob("*.SAFE"))

VV = next(SAFE.glob("measurement/*vv*.tiff"))
CAL = next(SAFE.glob("annotation/calibration/calibration-*vv*.xml"))
NOISE = next(SAFE.glob("annotation/calibration/noise-*vv*.xml"))

OUT = Path("data/sentinel1/S1A_20250704_VV_sigma0_db_correct.tif")


def tag(e):
    return e.tag.split("}")[-1]


def calibration_vectors(path):
    root = ET.parse(path).getroot()
    result = []

    for cv in root.iter():
        if tag(cv) != "calibrationVector":
            continue

        line = pixels = sigma = None

        for c in cv:
            t = tag(c)
            if t == "line":
                line = int(c.text.strip())
            elif t == "pixel":
                pixels = np.asarray(c.text.split(), dtype=np.float64)
            elif t == "sigmaNought":
                sigma = np.asarray(c.text.split(), dtype=np.float64)

        if line is not None and pixels is not None and sigma is not None:
            result.append((line, pixels, sigma))

    return sorted(result, key=lambda x: x[0])


def noise_vectors(path):
    root = ET.parse(path).getroot()
    result = []

    for nv in root.iter():
        if tag(nv) != "noiseVector":
            continue

        line = pixels = noise = None

        for c in nv:
            t = tag(c)
            if t == "line":
                line = int(c.text.strip())
            elif t == "pixel":
                pixels = np.asarray(c.text.split(), dtype=np.float64)
            elif t == "noiseLut":
                noise = np.asarray(c.text.split(), dtype=np.float64)

        if line is not None and pixels is not None and noise is not None:
            result.append((line, pixels, noise))

    return sorted(result, key=lambda x: x[0])


cal = calibration_vectors(CAL)
noise = noise_vectors(NOISE)

print("Calibration vectors:", len(cal))
print("Noise vectors:", len(noise))

with rasterio.open(VV) as src:
    profile = src.profile.copy()
    height, width = src.height, src.width

    profile.update(
        dtype="float32",
        count=1,
        compress="deflate",
        predictor=3,
        nodata=-9999.0,
    )

    cal_lines = np.array([x[0] for x in cal], dtype=float)
    noise_lines = np.array([x[0] for x in noise], dtype=float)

    with rasterio.open(OUT, "w", **profile) as dst:

        for row in range(height):

            dn = src.read(
                1,
                window=((row, row + 1), (0, width))
            ).astype(np.float64)[0]

            # Calibration interpolation in azimuth direction
            ci = np.searchsorted(cal_lines, row)
            ci = min(max(ci, 1), len(cal) - 1)
            c0, c1 = ci - 1, ci

            p0, s0 = cal[c0][1], cal[c0][2]
            p1, s1 = cal[c1][1], cal[c1][2]

            sigma0_lut = np.interp(
                np.arange(width), p0, s0
            )
            sigma1_lut = np.interp(
                np.arange(width), p1, s1
            )

            a = (
                (row - cal_lines[c0]) /
                (cal_lines[c1] - cal_lines[c0])
            )

            sigma_lut = sigma0_lut + a * (
                sigma1_lut - sigma0_lut
            )

            # Noise LUT
            ni = np.searchsorted(noise_lines, row)
            ni = min(max(ni, 1), len(noise) - 1)
            n0, n1 = ni - 1, ni

            np0, nv0 = noise[n0][1], noise[n0][2]
            np1, nv1 = noise[n1][1], noise[n1][2]

            noise0 = np.interp(
                np.arange(width), np0, nv0
            )
            noise1 = np.interp(
                np.arange(width), np1, nv1
            )

            a_n = (
                (row - noise_lines[n0]) /
                (noise_lines[n1] - noise_lines[n0])
            )

            noise_lut = noise0 + a_n * (
                noise1 - noise0
            )

            # Sentinel-1 GRD sigma0 calibration
            power = (
                dn * dn - noise_lut
            ) / (sigma_lut * sigma_lut)

            power = np.maximum(power, 1e-12)

            db = 10.0 * np.log10(power)

            db[~np.isfinite(db)] = -9999.0

            dst.write(
                db.astype(np.float32)[None, :],
                1,
                window=((row, row + 1), (0, width))
            )

            if row % 1000 == 0:
                print(f"{row}/{height}")

print("\nDONE")
print(OUT)
