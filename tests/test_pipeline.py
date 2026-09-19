"""
Comprehensive Automated Test Suite for Oil Spill Detection & Attribution Pipeline.
Compatible with standard Python unittest and pytest runners.
"""

import unittest
from gis.processing.geometry import haversine_distance, geodesic_polygon_area, extract_spill_geometry
from ml.metrics.evaluation import calculate_metrics
from ml.datasets.synthetic_sar import generate_synthetic_sar_scene
from drift.models.lagrangian import LagrangianDriftModel
from ais.trajectory import AISTrajectoryEngine
from attribution.scorer import ExplainableAttributionScorer
from backend.app.services.pipeline_service import PipelineService


class TestOilSpillAttributionPipeline(unittest.TestCase):

    def test_haversine_distance(self):
        """Test great-circle distance between known coordinates."""
        dist = haversine_distance(0.0, 0.0, 1.0, 0.0)
        self.assertAlmostEqual(dist, 111.19, delta=0.5)

    def test_geodesic_polygon_area(self):
        """Test geodesic area calculation for a WGS84 polygon ring."""
        box = [
            [0.0, 0.0],
            [0.1, 0.0],
            [0.1, 0.1],
            [0.0, 0.1],
            [0.0, 0.0]
        ]
        area = geodesic_polygon_area(box)
        self.assertGreater(area, 100.0)
        self.assertLess(area, 150.0)

    def test_evaluation_metrics(self):
        """Test IoU and Dice calculation on binary masks."""
        pred = [[1, 1, 0], [0, 1, 0], [0, 0, 0]]
        target = [[1, 1, 0], [0, 0, 0], [0, 0, 0]]

        metrics = calculate_metrics(pred, target)
        self.assertEqual(metrics["true_positives"], 2)
        self.assertEqual(metrics["false_positives"], 1)
        self.assertEqual(metrics["false_negatives"], 0)
        self.assertAlmostEqual(metrics["precision"], 2.0 / 3.0, delta=0.01)
        self.assertAlmostEqual(metrics["recall"], 1.0, delta=0.01)
        self.assertGreater(metrics["iou"], 0.6)
        self.assertGreater(metrics["dice"], 0.7)

    def test_synthetic_sar_generation(self):
        """Test synthetic SAR raster and ground-truth mask generation."""
        img, mask, meta = generate_synthetic_sar_scene(width=64, height=64, seed=42)
        self.assertEqual(len(img), 64)
        self.assertEqual(len(mask), 64)
        self.assertIn("bbox", meta)

    def test_lagrangian_drift_backtracking(self):
        """Test Lagrangian particle backtracking physics and origin uncertainty."""
        drift_model = LagrangianDriftModel()
        centroid = (28.72, -88.40)
        obs_time = "2026-08-28T06:00:00Z"
        
        result = drift_model.simulate(
            centroid=centroid,
            spill_polygon=[[-88.41, 28.71], [-88.39, 28.71], [-88.39, 28.73], [-88.41, 28.71]],
            observation_time_iso=obs_time,
            drift_hours=10.0,
            num_particles=20,
            mode="BACKWARD"
        )
        
        self.assertEqual(result["mode"], "BACKWARD")
        self.assertIn("probable_origin", result)
        origin_cent = result["probable_origin"]["centroid"]
        self.assertEqual(len(origin_cent), 2)
        self.assertGreater(result["probable_origin"]["uncertainty_radius_km"], 0.5)
        self.assertGreater(len(result["particle_trajectories"]), 0)

    def test_ais_trajectory_reconstruction(self):
        """Test AIS point grouping and trajectory construction."""
        engine = AISTrajectoryEngine()
        raw_pts = [
            {"mmsi": "111222333", "latitude": 28.60, "longitude": -88.50, "sog": 12.0, "cog": 90.0, "timestamp": "2026-08-28T00:00:00Z", "vessel_name": "TEST VESSEL"},
            {"mmsi": "111222333", "latitude": 28.60, "longitude": -88.40, "sog": 12.2, "cog": 90.0, "timestamp": "2026-08-28T01:00:00Z", "vessel_name": "TEST VESSEL"},
            {"mmsi": "111222333", "latitude": 28.60, "longitude": -88.30, "sog": 12.1, "cog": 90.0, "timestamp": "2026-08-28T02:00:00Z", "vessel_name": "TEST VESSEL"},
        ]
        trajs = engine.reconstruct_trajectories(
            raw_pts,
            origin_centroid=(28.60, -88.40),
            origin_uncertainty_radius_km=5.0,
            release_window_start="2026-08-28T00:30:00Z",
            release_window_end="2026-08-28T01:30:00Z"
        )
        self.assertEqual(len(trajs), 1)
        v = trajs[0]
        self.assertEqual(v["mmsi"], "111222333")
        self.assertAlmostEqual(v["min_distance_to_origin_km"], 0.0, delta=0.5)
        self.assertTrue(v["intersects_origin_zone"])
        self.assertEqual(v["time_delta_to_release_window_hours"], 0.0)

    def test_explainable_scoring(self):
        """Test multi-factor candidate scoring and normalization."""
        scorer = ExplainableAttributionScorer()
        mock_traj = {
            "mmsi": "999888777",
            "vessel_name": "TANKER ALPHA",
            "vessel_type": "Crude Oil Tanker",
            "imo": "9123456",
            "flag": "Panama",
            "length_m": 240.0,
            "min_distance_to_origin_km": 0.8,
            "time_delta_to_release_window_hours": 0.0,
            "intersects_origin_zone": True,
            "cpa_speed_knots": 11.5,
            "average_speed_knots": 11.8,
            "cpa_timestamp": "2026-08-28T01:00:00Z",
            "cpa_coordinates": [28.60, -88.40],
            "track_coordinates": [[-88.5, 28.6], [-88.4, 28.6], [-88.3, 28.6]]
        }
        score_res = scorer.score_vessel(mock_traj, origin_uncertainty_radius_km=4.0)
        self.assertGreater(score_res["composite_score"], 0.75)
        self.assertEqual(score_res["priority_level"], "HIGH PRIORITY CANDIDATE")
        self.assertIn("feature_breakdown", score_res)
        self.assertIn("evidence_narrative", score_res)
        self.assertIn("scientific_disclaimer", score_res)

    def test_pipeline_service_full_workflow(self):
        """Test complete end-to-end service execution."""
        service = PipelineService(data_mode="DEMO")
        scenes = service.get_scenes()
        self.assertGreater(len(scenes), 0)
        
        scene_id = scenes[0]["scene_id"]
        res = service.run_full_analysis(scene_id=scene_id, drift_hours=8.0, num_particles=20)
        
        self.assertEqual(res["status"], "COMPLETED")
        self.assertIn("detection", res)
        self.assertIn("drift", res)
        self.assertIn("attribution", res)
        self.assertGreater(res["attribution"]["total_candidates"], 0)

    def test_demo_mode_no_credentials_required(self):
        """Verify that DEMO mode does NOT require any live API credentials and operates cleanly."""
        service = PipelineService(data_mode="DEMO")
        status = service.validate_credentials()
        self.assertTrue(status["valid"])
        self.assertEqual(status["mode"], "DEMO")
        self.assertIn("DEMO mode active", status["message"])
        # Verify scene retrieval and detection works out of the box
        scenes = service.get_scenes()
        self.assertGreater(len(scenes), 0)

    def test_real_mode_missing_credentials_validation(self):
        """Verify that REAL mode validates and identifies missing credentials without crashing."""
        import os
        # Ensure test runs in unconfigured environment
        orig_user = os.environ.pop("COPERNICUS_USERNAME", None)
        orig_secret = os.environ.pop("COPERNICUS_CLIENT_SECRET", None)
        orig_cmems = os.environ.pop("COPERNICUS_MARINE_USERNAME", None)
        orig_cds = os.environ.pop("CDS_API_KEY", None)

        try:
            service = PipelineService(data_mode="REAL")
            status = service.validate_credentials()
            self.assertFalse(status["valid"])
            self.assertEqual(status["mode"], "REAL")
            self.assertGreater(len(status["missing_credentials"]), 0)
            self.assertTrue(any("COPERNICUS" in c for c in status["missing_credentials"]))
            self.assertTrue(any("CDS_API_KEY" in c for c in status["missing_credentials"]))
        finally:
            if orig_user: os.environ["COPERNICUS_USERNAME"] = orig_user
            if orig_secret: os.environ["COPERNICUS_CLIENT_SECRET"] = orig_secret
            if orig_cmems: os.environ["COPERNICUS_MARINE_USERNAME"] = orig_cmems
            if orig_cds: os.environ["CDS_API_KEY"] = orig_cds


if __name__ == "__main__":
    unittest.main()
