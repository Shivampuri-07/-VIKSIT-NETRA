"""
Torch-free verification tools for the production U-Net baseline.

* read_torch_checkpoint(): reads a torch.save() zip checkpoint into NumPy
  arrays WITHOUT torch, using a strict unpickler that only admits tensor
  rebuild functions, storage types and OrderedDict (read-only; the file is
  never modified).
* expected_state_dict_shapes(): the parameter shapes implied by
  ml/models/unet.py (SAROilSpillUNet, bilinear=True), for structural checks.
* unet_forward(): an INDEPENDENT NumPy re-implementation of the U-Net
  inference path (eval-mode BatchNorm, eps 1e-5; bilinear x2 upsampling with
  align_corners=True; skip concatenation [skip, upsampled]).
* real_scene_recipe(): replicates ml/inference/real_scene_inference.py
  (whole-image z-score over finite pixels, 256 px tiles, 32 px overlap,
  reflect padding, sigmoid, overlap averaging).
* read_strip_tiff_band1(): minimal GeoTIFF strip reader (deflate/none,
  little- or big-endian), used because PIL mis-decodes the big-endian
  float TIFFs in data/sentinel1/.

These tools VERIFY; they are not an inference path for production use.
"""

from __future__ import annotations

import collections
import pickle
import struct
import zipfile
import zlib
from typing import Dict, Tuple

import numpy as np

_DTYPES = {"FloatStorage": np.float32, "LongStorage": np.int64, "IntStorage": np.int32,
           "HalfStorage": np.float16, "DoubleStorage": np.float64, "BoolStorage": np.bool_}


def read_torch_checkpoint(path: str) -> dict:
    z = zipfile.ZipFile(path)
    pkl = [n for n in z.namelist() if n.endswith("/data.pkl")][0]
    prefix = pkl[: -len("data.pkl")]

    class _Strict(pickle.Unpickler):
        def find_class(self, module, name):
            if module == "torch._utils" and name == "_rebuild_tensor_v2":
                def rebuild(storage, offset, size, stride, *rest):
                    if len(size) == 0:
                        return storage[offset].copy()
                    return np.lib.stride_tricks.as_strided(
                        storage[offset:], shape=tuple(size), strides=[s * storage.itemsize for s in stride]).copy()
                return rebuild
            if module == "torch" and name in _DTYPES:
                return name
            if module == "collections" and name == "OrderedDict":
                return collections.OrderedDict
            raise pickle.UnpicklingError(f"refusing to load {module}.{name}")

        def persistent_load(self, pid):
            _, storage_type, key, _location, numel = pid
            return np.frombuffer(z.read(f"{prefix}data/{key}"), dtype=_DTYPES[storage_type])[:numel]

    return _Strict(z.open(pkl)).load()


def expected_state_dict_shapes(in_channels: int = 1, num_classes: int = 1) -> Dict[str, Tuple[int, ...]]:
    """Shapes implied by SAROilSpillUNet(in_channels, num_classes, bilinear=True)."""
    shapes: Dict[str, Tuple[int, ...]] = {}

    def double_conv(prefix, cin, cout, mid=None):
        mid = mid or cout
        shapes[f"{prefix}.double_conv.0.weight"] = (mid, cin, 3, 3)
        for k in ("weight", "bias", "running_mean", "running_var"):
            shapes[f"{prefix}.double_conv.1.{k}"] = (mid,)
        shapes[f"{prefix}.double_conv.1.num_batches_tracked"] = ()
        shapes[f"{prefix}.double_conv.3.weight"] = (cout, mid, 3, 3)
        for k in ("weight", "bias", "running_mean", "running_var"):
            shapes[f"{prefix}.double_conv.4.{k}"] = (cout,)
        shapes[f"{prefix}.double_conv.4.num_batches_tracked"] = ()

    double_conv("inc", in_channels, 32)
    for i, (a, b) in enumerate([(32, 64), (64, 128), (128, 256), (256, 256)], start=1):
        double_conv(f"down{i}.maxpool_conv.1", a, b)
    for i, (a, b) in enumerate([(512, 128), (256, 64), (128, 32), (64, 32)], start=1):
        double_conv(f"up{i}.conv", a, b, a // 2)
    shapes["outc.conv.weight"] = (num_classes, 32, 1, 1)
    shapes["outc.conv.bias"] = (num_classes,)
    return shapes


# ---------------------------------------------------------------- forward
def _conv3x3(x: np.ndarray, w: np.ndarray) -> np.ndarray:
    c, h, wd = x.shape
    xp = np.pad(x, ((0, 0), (1, 1), (1, 1)))
    win = np.lib.stride_tricks.sliding_window_view(xp, (3, 3), axis=(1, 2))  # C,H,W,3,3
    cols = np.ascontiguousarray(win.transpose(1, 2, 0, 3, 4)).reshape(h * wd, c * 9)
    return (cols @ w.reshape(w.shape[0], -1).T).T.reshape(w.shape[0], h, wd)


def _bn_relu(x, sd, p):
    g, b = sd[p + ".weight"], sd[p + ".bias"]
    m, v = sd[p + ".running_mean"], sd[p + ".running_var"]
    y = (x - m[:, None, None]) / np.sqrt(v + np.float32(1e-5))[:, None, None] * g[:, None, None] + b[:, None, None]
    return np.maximum(y, 0).astype(np.float32)


def _double_conv(x, sd, p):
    x = _bn_relu(_conv3x3(x, sd[p + ".double_conv.0.weight"]), sd, p + ".double_conv.1")
    return _bn_relu(_conv3x3(x, sd[p + ".double_conv.3.weight"]), sd, p + ".double_conv.4")


def _up2_align_corners(x: np.ndarray) -> np.ndarray:
    def axis_weights(n_in):
        n_out = 2 * n_in
        if n_in == 1:
            return np.zeros(n_out, int), np.zeros(n_out, int), np.zeros(n_out, np.float32)
        src = np.arange(n_out, dtype=np.float64) * (n_in - 1) / (n_out - 1)
        i0 = np.minimum(np.floor(src).astype(int), n_in - 1)
        i1 = np.minimum(i0 + 1, n_in - 1)
        return i0, i1, (src - i0).astype(np.float32)
    r0, r1, wr = axis_weights(x.shape[1])
    c0, c1, wc = axis_weights(x.shape[2])
    y = x[:, r0, :] * (1 - wr)[None, :, None] + x[:, r1, :] * wr[None, :, None]
    return (y[:, :, c0] * (1 - wc)[None, None, :] + y[:, :, c1] * wc[None, None, :]).astype(np.float32)


def unet_forward(sd: dict, x: np.ndarray) -> np.ndarray:
    """x: (1, H, W) float32 with H, W divisible by 16. Returns logits (1, H, W)."""
    x = x.astype(np.float32)
    x1 = _double_conv(x, sd, "inc")
    skips = [x1]
    h = x1
    for i in range(1, 5):
        c, hh, ww = h.shape
        h = h.reshape(c, hh // 2, 2, ww // 2, 2).max(axis=(2, 4))
        h = _double_conv(h, sd, f"down{i}.maxpool_conv.1")
        skips.append(h)
    h = skips[4]
    for i, skip in zip(range(1, 5), [skips[3], skips[2], skips[1], skips[0]]):
        h = _up2_align_corners(h)
        h = _double_conv(np.concatenate([skip, h], axis=0), sd, f"up{i}.conv")
    w, b = sd["outc.conv.weight"], sd["outc.conv.bias"]
    return (np.tensordot(w[:, :, 0, 0], h, axes=(1, 0)) + b[:, None, None]).astype(np.float32)


def sigmoid(z: np.ndarray) -> np.ndarray:
    return (1.0 / (1.0 + np.exp(-z.astype(np.float64)))).astype(np.float32)


def real_scene_recipe(image: np.ndarray, sd: dict, tile: int = 256, overlap: int = 32) -> np.ndarray:
    """Replicates ml/inference/real_scene_inference.py step by step."""
    image = image.astype(np.float32)
    valid = np.isfinite(image)
    mean = image[valid].mean()
    std = image[valid].std()
    image = np.nan_to_num(image, nan=0.0, posinf=0.0, neginf=0.0)
    image = (image - mean) / (std + 1e-6)
    stride = tile - overlap
    h, w = image.shape
    prob = np.zeros((h, w), np.float32)
    count = np.zeros((h, w), np.float32)
    for row in range(0, h, stride):
        for col in range(0, w, stride):
            r2, c2 = min(row + tile, h), min(col + tile, w)
            t = image[row:r2, col:c2]
            ph, pw = tile - t.shape[0], tile - t.shape[1]
            if ph > 0 or pw > 0:
                t = np.pad(t, ((0, ph), (0, pw)), mode="reflect")
            p = sigmoid(unet_forward(sd, t[None]))[0][: r2 - row, : c2 - col]
            prob[row:r2, col:c2] += p
            count[row:r2, col:c2] += 1
    return prob / np.maximum(count, 1)


# ---------------------------------------------------------------- TIFF
def read_strip_tiff_band1(path: str) -> np.ndarray:
    """Band 1 of a strip-organised, single-band TIFF (compression none/deflate)."""
    raw = open(path, "rb").read()
    bo = "<" if raw[:2] == b"II" else ">"
    (ifd,) = struct.unpack(bo + "I", raw[4:8])
    (n,) = struct.unpack(bo + "H", raw[ifd:ifd + 2])
    tags = {}
    sizes = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 11: 4, 12: 8, 16: 8}
    fmt = {1: "B", 2: "c", 3: "H", 4: "I", 11: "f", 12: "d", 16: "Q"}
    for i in range(n):
        tag, typ, cnt, val = struct.unpack(bo + "HHII", raw[ifd + 2 + 12 * i: ifd + 14 + 12 * i])
        size = sizes.get(typ, 1) * cnt
        data = raw[ifd + 10 + 12 * i: ifd + 14 + 12 * i] if size <= 4 else raw[val: val + size]
        if typ in fmt and typ != 2 and typ != 5:
            tags[tag] = struct.unpack(bo + fmt[typ] * cnt, data[: sizes[typ] * cnt])
    width, height = tags[256][0], tags[257][0]
    comp = tags.get(259, (1,))[0]
    if tags.get(317, (1,))[0] != 1:
        raise ValueError("TIFF predictor not supported")
    if 322 in tags:
        raise ValueError("tiled TIFF not supported")
    bits, sfmt = tags[258][0], tags.get(339, (1,))[0]
    dtype = {(32, 3): "f4", (64, 3): "f8", (8, 1): "u1", (16, 1): "u2", (16, 2): "i2", (32, 1): "u4", (32, 2): "i4"}[(bits, sfmt)]
    buf = b"".join((zlib.decompress(raw[o:o + c]) if comp in (8, 32946) else raw[o:o + c]) for o, c in zip(tags[273], tags[279]))
    if comp not in (1, 8, 32946):
        raise ValueError(f"compression {comp} not supported")
    return np.frombuffer(buf, dtype=bo + dtype)[: width * height].reshape(height, width).astype(dtype)
