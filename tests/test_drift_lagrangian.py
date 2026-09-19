"""
Python Lagrangian drift model: unit tests + cross-language consistency with the
operational TypeScript engine (server/lib/drift.ts).

Reference values: tests/fixtures/ts_drift_reference.json, produced by
    npx tsx server/tests/export_drift_reference.ts
Run:
    python3 -m unittest tests.test_drift_lagrangian -v
"""

import json
import math
import os
import sys
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, ROOT)

from drift.models.lagrangian import (  # noqa: E402
    LagrangianDriftModel, rotate_wind, haversine_km, bearing_deg, M_PER_DEG_LAT, percentile,
)

REF = json.load(open(os.path.join(ROOT, "tests", "fixtures", "ts_drift_reference.json")))
OBS = "2020-01-01T00:00:00Z"


def run(s, n=None, seed=11, polygon=None):
    m = LagrangianDriftModel(wind_factor=REF["wind_factor"], wind_deflection_deg=REF["deflection_deg"],
                             eddy_diffusivity=s["K"], unknown_current_sigma=s["sigma"])
    return m.simulate(centroid=(s["lat"], s["lon"]), spill_polygon=polygon or [], observation_time_iso=OBS,
                      drift_hours=s["hours"], timestep_minutes=s["dt_min"], num_particles=n or s["n"], mode=s["mode"], seed=seed,
                      current_uv=tuple(s["current"]) if s["current"] else None,
                      wind_uv=tuple(s["wind"]) if s["wind"] else None)


def ang_diff(a, b):
    return abs((a - b + 180) % 360 - 180)


class TestConventions(unittest.TestCase):
    def test_rotation_right_in_NH_left_in_SH(self):
        u, v = rotate_wind(0.0, 10.0, 5.0, 30.0)   # wind toward north
        self.assertAlmostEqual((math.degrees(math.atan2(u, v)) + 360) % 360, 5.0, places=9)
        u, v = rotate_wind(0.0, 10.0, 5.0, -30.0)
        self.assertAlmostEqual((math.degrees(math.atan2(u, v)) + 360) % 360, 355.0, places=9)
        self.assertEqual(rotate_wind(3.0, 4.0, 0.0, 10.0), (3.0, 4.0))

    def test_units_1ms_for_1h_is_3_6_km(self):
        r = LagrangianDriftModel(eddy_diffusivity=0, unknown_current_sigma=0).simulate(
            (10, 50), [], OBS, drift_hours=1, timestep_minutes=30, num_particles=3, mode="FORWARD", current_uv=(1, 0), wind_uv=(0, 0))
        self.assertAlmostEqual(r["displacement_km"], 3.6, places=3)
        self.assertAlmostEqual(r["displacement_bearing_deg"], 90.0, places=1)

    def test_lat_lon_ordering(self):
        r = LagrangianDriftModel(eddy_diffusivity=0, unknown_current_sigma=0).simulate(
            (28.9, -89.0), [], OBS, drift_hours=1, num_particles=2, mode="FORWARD", current_uv=(0, 0), wind_uv=(0, 0))
        self.assertAlmostEqual(r["final_centroid"][0], 28.9, places=2)      # [lat, lon]
        self.assertAlmostEqual(r["final_centroid"][1], -89.0, places=2)
        self.assertAlmostEqual(r["particle_trajectories"][0][0][1], 28.9, places=1)  # track points [lon, lat]
        self.assertAlmostEqual(r["particle_trajectories"][0][0][0], -89.0, places=1)

    def test_backward_reverses_forward(self):
        m = LagrangianDriftModel(eddy_diffusivity=0, unknown_current_sigma=0)
        f = m.simulate((28.9, -89.0), [], OBS, drift_hours=12, num_particles=1, mode="FORWARD", current_uv=(0.2, -0.1), wind_uv=(4, 3), seed=1)
        b = m.simulate(tuple(f["final_centroid"]), [], f["timestamps"][-1], drift_hours=12, num_particles=1, mode="BACKWARD", current_uv=(0.2, -0.1), wind_uv=(4, 3), seed=1)
        # Compare displacement VECTORS (not bearings: on a sphere the back-azimuth differs from
        # forward+180 deg by meridian convergence ~ dlon*sin(lat), here ~0.07 deg).
        self.assertAlmostEqual(f["displacement_km"], b["displacement_km"], places=3)
        fd = (f["final_centroid"][0] - f["start_centroid"][0], f["final_centroid"][1] - f["start_centroid"][1])
        bd = (b["final_centroid"][0] - b["start_centroid"][0], b["final_centroid"][1] - b["start_centroid"][1])
        self.assertLess(abs(fd[0] + bd[0]), 1e-6)
        self.assertLess(abs(fd[1] + bd[1]), 1e-3 * abs(fd[1]))
        self.assertLess(b["timestamps"][-1], b["timestamps"][0])  # backward in time

    def test_timestep_independence_constant_forcing(self):
        m = LagrangianDriftModel(eddy_diffusivity=0, unknown_current_sigma=0)
        a = m.simulate((28.9, -89), [], OBS, drift_hours=6, timestep_minutes=5, num_particles=2, mode="FORWARD", current_uv=(0.2, 0.1), wind_uv=(5, 5))
        b = m.simulate((28.9, -89), [], OBS, drift_hours=6, timestep_minutes=60, num_particles=2, mode="FORWARD", current_uv=(0.2, 0.1), wind_uv=(5, 5))
        self.assertAlmostEqual(a["displacement_km"], b["displacement_km"], places=4)

    def test_duration_never_silently_shortened(self):
        r = LagrangianDriftModel().simulate((28.9, -89), [], OBS, drift_hours=10, timestep_minutes=45, num_particles=5, mode="FORWARD", current_uv=(0, 0), wind_uv=(0, 0))
        self.assertEqual(r["num_steps"], 14)
        self.assertAlmostEqual(r["simulation_duration_hours"], 10.5)
        self.assertTrue(any("not a multiple" in w for w in r["warnings"]))

    def test_diffusion_matches_sqrt_2Kt(self):
        s = next(x for x in REF["scenarios"] if x["id"] == "diffusion_only_K10")
        r = run(s)
        sigma = math.sqrt(2 * s["K"] * s["hours"] * 3600 + 300 ** 2) / 1000  # per-axis, km (incl. 300 m seed cloud)
        expected_r50 = sigma * math.sqrt(2 * math.log(2))  # median radius of a 2-D isotropic Gaussian
        self.assertIsNone(r["probable_origin"])             # FORWARD run -> forecast block
        self.assertLess(abs(r["forecast"]["r50_km"] - expected_r50) / expected_r50, 0.05)


class TestProvenance(unittest.TestCase):
    def test_no_current_is_NOT_AVAILABLE_and_never_fabricated(self):
        r = LagrangianDriftModel().simulate((28.9, -89), [], OBS, drift_hours=6, num_particles=50, wind_uv=(2, 2), wind_status="REAL")
        ep = r["environmental_parameters"]
        self.assertEqual(r["forcing_provenance"]["current"], "NOT_AVAILABLE")
        self.assertIsNone(ep["surface_current_uo_ms"])
        self.assertIsNone(ep["surface_current_vo_ms"])
        self.assertTrue(r["forcing_provenance"]["current_prior_applied"])
        self.assertEqual(ep["unknown_current_prior_sigma_ms"], 0.1)
        self.assertEqual(r["forcing_provenance"]["wind"], "REAL")
        self.assertNotIn("0.22", json.dumps(ep))   # old fabricated default current
        self.assertTrue(any("NOT AVAILABLE" in w for w in r["warnings"]))

    def test_no_wind_is_NOT_AVAILABLE(self):
        r = LagrangianDriftModel().simulate((28.9, -89), [], OBS, drift_hours=1, num_particles=5)
        self.assertEqual(r["forcing_provenance"]["wind"], "NOT_AVAILABLE")
        self.assertIsNone(r["environmental_parameters"]["wind_10m_u_ms"])

    def test_supplied_current_keeps_caller_status_and_disables_prior(self):
        r = LagrangianDriftModel().simulate((28.9, -89), [], OBS, drift_hours=1, num_particles=5, current_uv=(0.3, 0.0), current_status="DEMO_CONSTANT", wind_uv=(0, 0))
        self.assertEqual(r["forcing_provenance"]["current"], "DEMO_CONSTANT")
        self.assertFalse(r["forcing_provenance"]["current_prior_applied"])

    def test_release_window_is_analyst_horizon_and_forward_has_no_origin(self):
        m = LagrangianDriftModel(eddy_diffusivity=0, unknown_current_sigma=0)
        b = m.simulate((28.9, -89), [], OBS, drift_hours=12, num_particles=5, mode="BACKWARD", current_uv=(0, 0), wind_uv=(0, 0))
        w = b["probable_origin"]["estimated_release_window"]
        self.assertEqual(w["window_type"], "ANALYST_SET_BACKTRACK_HORIZON")
        self.assertEqual(w["nominal_hours_ago"], 12)
        self.assertEqual(w["start_time"], "2019-12-31T12:00:00+00:00")
        f = m.simulate((28.9, -89), [], OBS, drift_hours=12, num_particles=5, mode="FORWARD", current_uv=(0, 0), wind_uv=(0, 0))
        self.assertIsNone(f["probable_origin"])
        self.assertIsNotNone(f["forecast"])

    def test_no_artificial_minimum_uncertainty(self):
        r = LagrangianDriftModel(eddy_diffusivity=0, unknown_current_sigma=0).simulate(
            (28.9, -89), [], OBS, drift_hours=1, num_particles=200, mode="BACKWARD", current_uv=(0, 0), wind_uv=(0, 0))
        self.assertLess(r["probable_origin"]["uncertainty_radius_km"], 1.0)  # old code floored this at 1.5 km

    def test_particles_seeded_inside_spill_polygon(self):
        poly = [[-89.1, 28.8], [-88.9, 28.8], [-88.9, 29.0], [-89.1, 29.0], [-89.1, 28.8]]
        r = LagrangianDriftModel().simulate((28.9, -89.0), poly, OBS, drift_hours=1, num_particles=40, current_uv=(0, 0), wind_uv=(0, 0))
        for tr in r["particle_trajectories"]:
            lon, lat = tr[0]
            self.assertTrue(-89.1 <= lon <= -88.9 and 28.8 <= lat <= 29.0)

    def test_existing_pipeline_test_contract_still_holds(self):
        # mirrors tests/test_pipeline.py::test_lagrangian_drift_backtracking (default constructor)
        r = LagrangianDriftModel().simulate((28.72, -88.40), [[-88.41, 28.71], [-88.39, 28.71], [-88.39, 28.73], [-88.41, 28.71]],
                                            "2026-08-28T06:00:00Z", drift_hours=10.0, num_particles=20, mode="BACKWARD")
        self.assertEqual(r["mode"], "BACKWARD")
        self.assertEqual(len(r["probable_origin"]["centroid"]), 2)
        self.assertGreater(r["probable_origin"]["uncertainty_radius_km"], 0.5)
        self.assertGreater(len(r["particle_trajectories"]), 0)


class TestCrossLanguageConsistency(unittest.TestCase):
    """Same scenarios through the TypeScript engine (fixture) and this model."""

    def test_deterministic_scenarios_match_typescript(self):
        for s in [x for x in REF["scenarios"] if x["deterministic"]]:
            with self.subTest(s["id"]):
                r = run(s)
                ts = s["ts"]
                self.assertEqual(r["simulation_duration_hours"], ts["simulated_hours"])
                tol = max(1e-3, 1e-4 * ts["displacement_km"])
                self.assertLess(abs(r["displacement_km"] - ts["displacement_km"]), tol, f'{r["displacement_km"]} vs {ts["displacement_km"]}')
                self.assertLess(ang_diff(r["displacement_bearing_deg"], ts["bearing_deg"]), 0.05)
                d_lat = r["final_centroid"][0] - r["start_centroid"][0]
                d_lon = r["final_centroid"][1] - r["start_centroid"][1]
                self.assertLess(abs(d_lat - ts["d_lat"]), 2e-5)
                self.assertLess(abs(d_lon - ts["d_lon"]), 2e-5 + 2e-4 * abs(ts["d_lon"]))
                self.assertEqual(r["timestamps"][-1].replace("+00:00", ".000Z"), ts["end_time"])

    def test_analytic_values(self):
        get = {x["id"]: x for x in REF["scenarios"]}
        self.assertAlmostEqual(run(get["current_east_1ms_1h"])["displacement_km"], 3.6, places=3)
        for sid, brg in (("wind_north_NH", 5.0), ("wind_north_SH", 355.0)):
            r = run(get[sid])
            self.assertAlmostEqual(r["displacement_km"], 0.03 * 10 * 6 * 3.6, places=3)
            self.assertLess(ang_diff(r["displacement_bearing_deg"], brg), 0.01)

    def test_statistical_scenarios_match_typescript_and_theory(self):
        for s in [x for x in REF["scenarios"] if not x["deterministic"]]:
            with self.subTest(s["id"]):
                r = run(s)
                reg = r["probable_origin"] or r["forecast"]
                if s["id"] == "diffusion_only_K10":
                    sig = math.sqrt(2 * s["K"] * s["hours"] * 3600 + 300 ** 2) / 1000
                else:
                    sig = math.sqrt((s["sigma"] * s["hours"] * 3600) ** 2 + 300 ** 2) / 1000
                theory50, theory90 = sig * math.sqrt(2 * math.log(2)), sig * math.sqrt(2 * math.log(10))
                for name, py, ts, th in (("r50", reg["r50_km"], s["ts"]["r50_km"], theory50), ("r90", reg["uncertainty_radius_km"], s["ts"]["r90_km"], theory90)):
                    self.assertLess(abs(py - ts) / ts, 0.05, f"{name}: python {py} vs ts {ts}")
                    self.assertLess(abs(py - th) / th, 0.05, f"{name}: python {py} vs theory {th:.3f}")
                self.assertEqual(r["forcing_provenance"]["current_prior_applied"], s["ts"]["current_prior_applied"])


if __name__ == "__main__":
    unittest.main()
