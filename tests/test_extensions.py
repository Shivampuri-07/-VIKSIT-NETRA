"""Extension points are honest: implemented pieces work, the rest refuse to produce outputs."""
import json, os, sys, unittest
import numpy as np
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..")); sys.path.insert(0, ROOT)
from ml.extensions import interfaces as X  # noqa: E402

class Const(X.SegmentationModel):
    def __init__(self, v): self.v = v
    def predict_proba(self, tile): return np.full(tile.shape, self.v, np.float32)

class TestExtensions(unittest.TestCase):
    def test_ensemble_mean_and_disagreement(self):
        m, s, note = X.SegmentationEnsemble([Const(0.2), Const(0.6)]).predict_with_disagreement(np.zeros((4, 4), np.float32))
        self.assertTrue(np.allclose(m, 0.4) and np.allclose(s, 0.2)); self.assertEqual(note, "2 members")
        m1, s1, n1 = X.SegmentationEnsemble([Const(0.3)]).predict_with_disagreement(np.zeros((2, 2), np.float32))
        self.assertTrue(np.allclose(s1, 0)); self.assertIn("no ensemble uncertainty", n1)

    def test_unavailable_models_refuse(self):
        for cls in (X.UNetPlusPlus, X.DeepLabV3Plus, X.SegFormer, X.SSLSAREncoder, X.LookAlikeClassifier, X.BayesianSegmentationUncertainty,
                    X.LearnedDriftCorrection, X.OceanFieldPredictor, X.TrajectoryModel, X.VesselRelationGNN, X.MultimodalFusion,
                    X.ProbabilisticAttributionModel, X.DomainAdapter, X.MultiSatelliteValidator):
            with self.subTest(cls.__name__), self.assertRaises(X.NotAvailableError) as cm:
                cls()
            self.assertRegex(str(cm.exception), r"\[(EXTENSION_POINT|BLOCKED_BY_DATA)\]")

    def test_drift_validation_gate(self):
        g = X.LearnedDriftCorrection.validation_gate
        self.assertFalse(g([5.0] * 5, [1.0] * 5)["accepted"])                 # too few cases
        self.assertTrue(g([10.0] * 30, [7.0] * 30)["accepted"])
        self.assertFalse(g([10.0] * 30, [9.5] * 30)["accepted"])              # improvement too small

    def test_feedback_and_queue(self):
        self.assertEqual(X.FeedbackRecord("INV-1", "vessel", "rejected", mmsi="367642980").validate(), [])
        self.assertEqual(set(X.FeedbackRecord("INV-1", "vessel", "maybe").validate()), {"verdict", "mmsi"})
        q = X.ActiveLearningQueue(); q.add("a", {"lookalike_risk": True}); q.add("b", {"uncertainty_high": True, "close_ranking": True})
        self.assertEqual([c for _, c, _ in q.top()], ["b", "a"])
        with self.assertRaises(KeyError):
            q.add("c", {"invented_signal": True})

    def test_capabilities_file_consistent(self):
        caps = json.load(open(os.path.join(ROOT, "ml/extensions/capabilities.json")))["capabilities"]
        ids = {c["id"] for c in caps}
        for needed in ("seg_ensemble", "lookalike", "drift_learned", "prob_attribution", "multi_satellite", "langgraph"):
            self.assertIn(needed, ids)

if __name__ == "__main__":
    unittest.main()
