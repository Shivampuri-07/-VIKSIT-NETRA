#!/usr/bin/env python3
"""
Fetch a small, real HISTORICAL surface-current field for the 2018-09-26 Gulf of Mexico event and write it as
an `aegis.env_field.v1` file that server/lib/environment.ts loads (data/currents/<scene_id>_currents.json).

Product (verified from the HYCOM THREDDS catalogue when this script was written):
  HYCOM + NCODA "GOMl0.04 / expt_32.5" (Southeast United States 1/25 degree ANALYSIS), 2018 hourly output.
  A data-assimilative ocean MODEL analysis, NOT direct observations and NOT a Copernicus Marine product.
  Variables `u` (eastward_sea_water_velocity) and `v` (northward_sea_water_velocity), m/s, surface (vertCoord 0 m).
  Coverage of the requested dataset: lon -98.0..-76.4, lat 18.09..31.96, 2018-01-01..2018-12-31.

Method: HYCOM's NetCDF Subset Service (no credentials, no extra libraries) is queried once per lattice node
(grid-as-point => the value of the nearest native 1/25 degree cell) and the nodes are assembled into a regular
[time][lat][lon] grid. NOTHING is filled, interpolated in time, or invented: a missing/fill value at any node or
time is stored as null (land / no data) and flagged downstream. Node values are nearest-native-cell values; lattice spacing (0.08 deg) is coarser than the
native grid (0.04 deg), i.e. a decimation, not an upsampling.

    python scripts/fetch_hycom_currents.py            # writes data/currents/GOM_S1A_20180926_REAL_currents.json
    python scripts/fetch_hycom_currents.py --dry-run  # print the plan only
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import csv
import hashlib
import io
import json
import math
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BASE = "https://ncss.hycom.org/thredds/ncss/grid/GOMl0.04/expt_32.5/2018/hrly"
SCENE_ID = "GOM_S1A_20180926_REAL"
T_START, T_END = "2018-09-26T02:00:00Z", "2018-09-28T15:00:00Z"   # T0-12 h (02:23:49Z) .. T0+48 h (2018-09-28T14:23:49Z), padded to whole hours
LATS = [round(28.50 + 0.08 * i, 2) for i in range(13)]           # 28.50 .. 29.46 (slick lat 28.78-28.95 plus the 48 h northward drift)
LONS = [round(-89.30 + 0.08 * i, 2) for i in range(20)]          # -89.30 .. -87.78 (slick lon -89.07..-88.92 plus the 48 h eastward drift; ocean-only)
FILL = 1.0e29


def fetch_point(lat: float, lon: float, tries: int = 4):
    q = {"var": ["u", "v"], "latitude": lat, "longitude": lon, "time_start": T_START, "time_end": T_END,
         "vertCoord": 0, "accept": "csv"}
    url = BASE + "?" + urllib.parse.urlencode(q, doseq=True)
    last = None
    for k in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=90) as r:
                raw = r.read()
            rows = list(csv.reader(io.StringIO(raw.decode("utf-8"))))
            return url, raw, rows
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:   # retry transient errors only
            last = e
            time.sleep(1.5 * (k + 1))
    raise RuntimeError(f"HYCOM request failed for ({lat}, {lon}): {last}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--out", default=os.path.join(PROJECT_ROOT, "data", "currents", f"{SCENE_ID}_currents.json"))
    ap.add_argument("--workers", type=int, default=8)
    a = ap.parse_args(argv)

    nodes = [(la, lo) for la in LATS for lo in LONS]
    print(f"plan: {len(nodes)} lattice nodes ({len(LATS)} lat x {len(LONS)} lon), {T_START} .. {T_END}, surface (0 m)")
    if a.dry_run:
        return 0

    started = datetime.now(timezone.utc)
    results = {}
    with cf.ThreadPoolExecutor(max_workers=a.workers) as ex:
        futs = {ex.submit(fetch_point, la, lo): (la, lo) for la, lo in nodes}
        for f in cf.as_completed(futs):
            results[futs[f]] = f.result()
    print(f"downloaded {len(results)} responses")

    times = None
    u = None
    v = None
    bad = []
    sha = hashlib.sha256()
    for (la, lo) in nodes:                      # deterministic order for the checksum
        url, raw, rows = results[(la, lo)]
        sha.update(raw)
        header, data = rows[0], rows[1:]
        assert header[0] == "time" and header[-2].startswith("u[") and header[-1].startswith("v["), f"unexpected columns {header}"
        if times is None:
            times = [r[0] for r in data]
            u = [[[None] * len(LONS) for _ in LATS] for _ in times]
            v = [[[None] * len(LONS) for _ in LATS] for _ in times]
        elif [r[0] for r in data] != times:
            raise RuntimeError(f"time axis differs at node ({la}, {lo})")
        iy, ix = LATS.index(la), LONS.index(lo)
        for it, r in enumerate(data):
            uu, vv = float(r[-2]), float(r[-1])
            if not (math.isfinite(uu) and math.isfinite(vv)) or abs(uu) > FILL or abs(vv) > FILL:
                bad.append((la, lo))          # land / no data: stored as null (never filled)
                u[it][iy][ix] = None
                v[it][iy][ix] = None
                continue
            if abs(uu) > 5 or abs(vv) > 5:  # noqa
                raise RuntimeError(f"implausible surface current at node ({la}, {lo}) time {r[0]}: {uu}, {vv}")
            u[it][iy][ix] = round(uu, 5)
            v[it][iy][ix] = round(vv, 5)

    land_nodes = sorted(set(bad))
    if len(land_nodes) > 0.6 * len(nodes):
        raise RuntimeError(f"{len(land_nodes)} of {len(nodes)} lattice nodes have no ocean data: the lattice is mostly land; refusing to write it")
    print(f"{len(land_nodes)} land/no-data node(s) stored as null (not filled): {land_nodes}")
    # times as returned by the server (ISO, UTC); HYCOM stamps are hourly with sub-minute offsets
    iso = [t if t.endswith("Z") else t + "Z" for t in times]
    okv = lambda arr: [x for s in arr for r in s for x in r if x is not None]
    stats = {"u_min": min(okv(u)), "u_max": max(okv(u)), "v_min": min(okv(v)), "v_max": max(okv(v))}
    out = {
        "schema": "aegis.env_field.v1",
        "kind": "current",
        "source": "HYCOM + NCODA Southeast United States 1/25 deg analysis (GOMl0.04/expt_32.5), hourly, surface (data-assimilative ocean MODEL analysis; not observations; not Copernicus Marine)",
        "source_file": None,
        "variables": {"u": "u (eastward_sea_water_velocity, m/s) at depth 0 m", "v": "v (northward_sea_water_velocity, m/s) at depth 0 m"},
        "units": "m s-1",
        "times": iso,
        "lats": LATS,
        "lons": LONS,
        "u": u,
        "v": v,
        "index_order": "[time][lat][lon]",
        "provenance": {
            "status": "REAL_HISTORICAL_MODEL_ANALYSIS",
            "is_observation": False,
            "product": "HYCOM + NCODA GOMl0.04/expt_32.5 (2018 hourly)",
            "service": BASE,
            "credit": "HYCOM Consortium / NRL (public THREDDS server, ncss.hycom.org). Redistribution terms not verified here; cite the HYCOM consortium.",
            "request": {"variables": ["u", "v"], "vertCoord_m": 0, "time_start": T_START, "time_end": T_END, "lattice_lat": LATS, "lattice_lon": LONS,
                        "per_node": "NetCDF Subset Service grid-as-point (nearest native 1/25 deg cell), accept=csv"},
            "native_resolution": "1/25 degree (~4 km), hourly",
            "resampling": "none in time; nearest native cell per lattice node (0.08 deg lattice = decimation of the native grid)",
            "gap_policy": "no filling: land / no-data nodes are stored as null; the drift engine reports samples touching them as LAND_OR_NO_DATA (zero current, flagged)",
            "land_or_no_data_nodes": [list(n) for n in land_nodes],
            "downloaded_utc": started.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "raw_responses_sha256": sha.hexdigest(),
            "value_ranges_ms": stats,
            "coverage_note": "Covers T0-12 h .. T0+48 h of the 2018-09-26T14:23:49Z observation. Positions outside the lattice are EDGE_CLAMPED by the drift engine.",
            "limitations": ["Model analysis (assimilates observations but is not an observation)", "No tides/Stokes drift/waves beyond what the model contains", "Surface level = model layer at 0 m"],
        },
    }
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    json.dump(out, open(a.out, "w"))
    print(f"wrote {os.path.relpath(a.out, PROJECT_ROOT)}: {len(iso)} times x {len(LATS)} x {len(LONS)}; ranges {stats}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
