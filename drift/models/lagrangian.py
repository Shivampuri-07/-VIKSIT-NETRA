"""
Lagrangian particle drift / backtracking model (Python implementation).

Conventions (kept identical to the operational TypeScript engine,
server/lib/drift.ts; cross-checked by tests/test_drift_lagrangian.py):

  * positions are (lat, lon) in decimal degrees, WGS84; GeoJSON-style output
    tracks/polygons are [lon, lat]
  * velocities (u, v) are m/s, u = eastward, v = northward; for wind AND
    current, (u, v) is the direction the air/water moves TOWARD
  * surface drift velocity = current + wind_factor * R(theta) * wind10
    where R rotates the wind CLOCKWISE (to the right) by theta in the
    northern hemisphere (lat >= 0) and counter-clockwise (to the left) in the
    southern hemisphere
  * metres -> degrees with the IUGG mean Earth radius 6 371 008.8 m
  * integration: RK2 midpoint, n = ceil(hours / dt) steps; the simulated
    duration (n * dt) is reported, never silently shortened
  * BACKWARD mode integrates the same velocity with the time sign reversed
  * diffusion: isotropic random walk, per-axis std sqrt(2 K dt) metres
  * forcing here is spatially and temporally CONSTANT (no gridded fields,
    no interpolation, no boundaries); gridded ERA5/CMEMS forcing with
    bilinear/linear interpolation exists only in the TypeScript engine

Honesty rules:
  * no environmental value is invented: if wind or current is not supplied,
    its provenance is NOT_AVAILABLE and it is treated as zero-mean; an unknown
    current is represented by a per-particle random constant current
    N(0, sigma^2) (uncertainty, not an observation)
  * the backtrack horizon is analyst-set; no release time is estimated
  * the P90 radius is reported as computed (no artificial minimum)
"""

import math
import random
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

EARTH_RADIUS_M = 6371008.8
M_PER_DEG_LAT = EARTH_RADIUS_M * math.pi / 180.0


def m_per_deg_lon(lat_deg: float) -> float:
    return M_PER_DEG_LAT * max(1e-6, math.cos(math.radians(lat_deg)))


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return (EARTH_RADIUS_M / 1000.0) * 2 * math.atan2(math.sqrt(a), math.sqrt(max(0.0, 1 - min(1.0, a))))


def bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def rotate_wind(u: float, v: float, deflection_deg: float, lat: float) -> Tuple[float, float]:
    """Clockwise (to the right) in the NH, counter-clockwise in the SH."""
    th = (1.0 if lat >= 0 else -1.0) * math.radians(deflection_deg)
    c, s = math.cos(th), math.sin(th)
    return u * c + v * s, -u * s + v * c


def percentile(sorted_asc: List[float], p: float) -> float:
    """Linear-interpolated percentile (same definition as server/lib/geo.ts)."""
    if not sorted_asc:
        return float("nan")
    idx = min(len(sorted_asc) - 1, max(0.0, (len(sorted_asc) - 1) * p))
    lo, hi = math.floor(idx), math.ceil(idx)
    return sorted_asc[lo] + (sorted_asc[hi] - sorted_asc[lo]) * (idx - lo)


def point_in_ring(lon: float, lat: float, ring: List[List[float]]) -> bool:
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / ((yj - yi) or 1e-30) + xi:
            inside = not inside
        j = i
    return inside


class LagrangianDriftModel:
    """2D Lagrangian particle tracking under constant wind/current forcing."""

    def __init__(
        self,
        wind_factor: float = 0.03,           # fraction of 10 m wind speed
        wind_deflection_deg: float = 5.0,    # to the right in NH, left in SH
        eddy_diffusivity: float = 2.5,       # horizontal eddy diffusivity K, m^2/s
        unknown_current_sigma: float = 0.1,  # m/s; prior used only when no current is supplied
        default_current_u: Optional[float] = None,
        default_current_v: Optional[float] = None,
        default_wind_u: Optional[float] = None,
        default_wind_v: Optional[float] = None,
    ):
        # Defaults are None: the model never invents forcing. A caller that
        # deliberately configures defaults gets them labelled CALLER_DEFAULT.
        self.wind_factor = wind_factor
        self.wind_deflection_deg = wind_deflection_deg
        self.eddy_diffusivity = eddy_diffusivity
        self.unknown_current_sigma = unknown_current_sigma
        self.default_current_u = default_current_u
        self.default_current_v = default_current_v
        self.default_wind_u = default_wind_u
        self.default_wind_v = default_wind_v

    # ------------------------------------------------------------------ forcing
    @staticmethod
    def _resolve(uv, status, du, dv, label):
        if uv is not None and uv[0] is not None and uv[1] is not None:
            return float(uv[0]), float(uv[1]), (status or "CALLER_SUPPLIED"), None
        if du is not None and dv is not None:
            return float(du), float(dv), "CALLER_DEFAULT", f"{label}: model-level default used (labelled CALLER_DEFAULT, not an observation)."
        return 0.0, 0.0, "NOT_AVAILABLE", f"{label}: NOT AVAILABLE, no value supplied; treated as zero-mean."

    def simulate(
        self,
        centroid: Tuple[float, float],          # (lat, lon)
        spill_polygon: List[List[float]],       # [[lon, lat], ...] closed ring (optional)
        observation_time_iso: str,
        drift_hours: float = 12.0,
        timestep_minutes: float = 30.0,
        num_particles: int = 60,
        mode: str = "BACKWARD",
        seed: int = 42,
        current_uv: Optional[Tuple[float, float]] = None,
        wind_uv: Optional[Tuple[float, float]] = None,
        current_status: Optional[str] = None,
        wind_status: Optional[str] = None,
    ) -> Dict[str, Any]:
        if not (drift_hours > 0):
            raise ValueError("drift_hours must be > 0")
        if not (timestep_minutes > 0):
            raise ValueError("timestep_minutes must be > 0")
        mode = str(mode).upper()
        if mode not in ("BACKWARD", "FORWARD"):
            raise ValueError("mode must be BACKWARD or FORWARD")
        num_particles = max(1, int(num_particles))

        warnings: List[str] = []
        wu, wv, w_status, w_warn = self._resolve(wind_uv, wind_status, self.default_wind_u, self.default_wind_v, "Wind")
        cu, cv, c_status, c_warn = self._resolve(current_uv, current_status, self.default_current_u, self.default_current_v, "Current")
        warnings += [x for x in (w_warn, c_warn) if x]
        apply_prior = c_status == "NOT_AVAILABLE" and self.unknown_current_sigma > 0
        if apply_prior:
            warnings.append(f"Unknown current represented by a zero-mean random prior (sigma {self.unknown_current_sigma} m/s per particle); envelopes include this uncertainty.")

        direction = -1.0 if mode == "BACKWARD" else 1.0
        dt = timestep_minutes * 60.0
        n_steps = max(1, math.ceil(drift_hours * 3600.0 / dt - 1e-9))
        simulated_hours = n_steps * dt / 3600.0
        if abs(simulated_hours - drift_hours) > 1e-9:
            warnings.append(f"Requested {drift_hours} h is not a multiple of the {timestep_minutes} min step; simulated {simulated_hours} h ({n_steps} steps).")
        diff_std = math.sqrt(2.0 * max(0.0, self.eddy_diffusivity) * dt)
        obs = datetime.fromisoformat(str(observation_time_iso).replace("Z", "+00:00"))
        rnd = random.Random(seed)

        # ---- seeding: uniformly inside the spill polygon, else a 300 m Gaussian cloud
        lat0, lon0 = float(centroid[0]), float(centroid[1])
        positions: List[List[float]] = []
        ring = spill_polygon if spill_polygon and len(spill_polygon) >= 4 else None
        if ring:
            lons = [p[0] for p in ring]
            lats = [p[1] for p in ring]
            tries = 0
            while len(positions) < num_particles and tries < num_particles * 200:
                tries += 1
                lon = min(lons) + rnd.random() * (max(lons) - min(lons))
                lat = min(lats) + rnd.random() * (max(lats) - min(lats))
                if point_in_ring(lon, lat, ring):
                    positions.append([lat, lon])
            if len(positions) < num_particles:
                warnings.append("Spill polygon too small/degenerate for seeding; remaining particles seeded as a 300 m cloud at the centroid.")
        else:
            warnings.append("No valid spill polygon (>= 4 vertices): particles seeded as a 300 m Gaussian cloud at the centroid.")
        while len(positions) < num_particles:
            positions.append([lat0 + rnd.gauss(0, 300) / M_PER_DEG_LAT, lon0 + rnd.gauss(0, 300) / m_per_deg_lon(lat0)])

        prior = [(rnd.gauss(0, self.unknown_current_sigma), rnd.gauss(0, self.unknown_current_sigma)) if apply_prior else (0.0, 0.0) for _ in positions]
        start_lat = sum(p[0] for p in positions) / len(positions)
        start_lon = sum(p[1] for p in positions) / len(positions)
        histories = [[(p[0], p[1])] for p in positions]
        timestamps = [obs.isoformat()]

        def velocity(lat: float, i: int) -> Tuple[float, float]:
            ru, rv = rotate_wind(wu, wv, self.wind_deflection_deg, lat)
            return cu + prior[i][0] + self.wind_factor * ru, cv + prior[i][1] + self.wind_factor * rv

        # ---- RK2 midpoint integration (same scheme as the TypeScript engine)
        for step in range(1, n_steps + 1):
            timestamps.append((obs + timedelta(seconds=direction * step * dt)).isoformat())
            for i, (lat, lon) in enumerate(positions):
                u1, v1 = velocity(lat, i)
                mid_lat = lat + direction * v1 * 0.5 * dt / M_PER_DEG_LAT
                u2, v2 = velocity(mid_lat, i)
                dx = direction * u2 * dt + rnd.gauss(0, diff_std)
                dy = direction * v2 * dt + rnd.gauss(0, diff_std)
                new_lat = lat + dy / M_PER_DEG_LAT
                new_lon = lon + dx / m_per_deg_lon(0.5 * (lat + new_lat))
                positions[i] = [new_lat, new_lon]
                histories[i].append((new_lat, new_lon))

        c_lat = sum(p[0] for p in positions) / len(positions)
        c_lon = sum(p[1] for p in positions) / len(positions)
        dists = sorted(haversine_km(p[0], p[1], c_lat, c_lon) for p in positions)
        r50 = percentile(dists, 0.5)
        r90 = percentile(dists, 0.9)
        circle = []
        for k in range(32):
            th = 2 * math.pi * k / 32
            circle.append([round(c_lon + (r90 * 1000 / m_per_deg_lon(c_lat)) * math.cos(th), 6), round(c_lat + (r90 * 1000 / M_PER_DEG_LAT) * math.sin(th), 6)])
        circle.append(circle[0])

        n_tracks = min(15, num_particles)
        idx = [int(i * (num_particles - 1) / max(1, n_tracks - 1)) for i in range(n_tracks)]
        tracks = [[[round(pt[1], 6), round(pt[0], 6)] for pt in histories[i]] for i in idx]
        end_time = obs + timedelta(seconds=direction * n_steps * dt)
        region = {
            "centroid": [round(c_lat, 6), round(c_lon, 6)],
            "uncertainty_radius_km": round(r90, 3),
            "r50_km": round(r50, 3),
            "uncertainty_polygon": circle,
            "uncertainty_polygon_type": "circle_of_p90_radius",
        }
        spd = lambda u, v: math.hypot(u, v)
        return {
            "mode": mode,
            "engine": "python-lagrangian (constant forcing)",
            "simulation_duration_hours": simulated_hours,
            "requested_duration_hours": drift_hours,
            "timestep_minutes": timestep_minutes,
            "num_steps": n_steps,
            "particle_count": num_particles,
            "seed": seed,
            "environmental_parameters": {
                "surface_current_uo_ms": None if c_status == "NOT_AVAILABLE" else round(cu, 3),
                "surface_current_vo_ms": None if c_status == "NOT_AVAILABLE" else round(cv, 3),
                "current_speed_knots": None if c_status == "NOT_AVAILABLE" else round(spd(cu, cv) * 1.943844, 2),
                "current_status": c_status,
                "wind_10m_u_ms": None if w_status == "NOT_AVAILABLE" else round(wu, 3),
                "wind_10m_v_ms": None if w_status == "NOT_AVAILABLE" else round(wv, 3),
                "wind_speed_knots": None if w_status == "NOT_AVAILABLE" else round(spd(wu, wv) * 1.943844, 2),
                "wind_status": w_status,
                "wind_leeway_factor": self.wind_factor,
                "wind_deflection_deg": self.wind_deflection_deg,
                "deflection_sense": "clockwise (to the right of the wind) in the northern hemisphere; counter-clockwise in the southern hemisphere",
                "eddy_diffusivity_m2s": self.eddy_diffusivity,
                "unknown_current_prior_sigma_ms": self.unknown_current_sigma if apply_prior else None,
            },
            "forcing_provenance": {"wind": w_status, "current": c_status, "current_prior_applied": apply_prior},
            "start_centroid": [round(start_lat, 6), round(start_lon, 6)],
            "final_centroid": [round(c_lat, 6), round(c_lon, 6)],
            "displacement_km": round(haversine_km(start_lat, start_lon, c_lat, c_lon), 4),
            "displacement_bearing_deg": round(bearing_deg(start_lat, start_lon, c_lat, c_lon), 2),
            "probable_origin": None if mode == "FORWARD" else {
                **region,
                "estimated_release_window": {
                    "start_time": end_time.isoformat(),
                    "end_time": obs.isoformat(),
                    "nominal_hours_ago": simulated_hours,
                    "window_type": "ANALYST_SET_BACKTRACK_HORIZON",
                    "note": "Release time is not estimated by the model; this is the analyst-selected backtrack horizon.",
                },
            },
            "forecast": {**region, "horizon_hours": simulated_hours} if mode == "FORWARD" else None,
            "particle_trajectories": tracks,
            "timestamps": timestamps,
            "warnings": warnings,
            "model_limitations": [
                "Constant (spatially and temporally uniform) forcing only; no gridded wind/current interpolation.",
                "Transport only: no weathering, beaching or stranding.",
                "Uncertainty polygon is a circle of the P90 radius around the ensemble centroid, not a particle hull.",
            ],
            "disclaimer": "Lagrangian particle drift approximation (2D advection-diffusion). The origin/forecast is an uncertainty region, not a confirmed location.",
        }
