"""
Explainable Candidate Vessel Scoring and Attribution Engine.
Combines spatial proximity, temporal alignment, trajectory intersection,
and vessel kinematic characteristics into a normalized, transparent score.
Generates natural-language evidence narratives with strict uncertainty disclaimers.
"""

import math
from typing import Dict, Any, List, Optional


class ExplainableAttributionScorer:
    """
    Computes explainable vessel candidate scores using configurable weights
    and generates auditable decision-support rationale.
    """
    def __init__(
        self,
        weight_spatial: float = 0.35,
        weight_temporal: float = 0.25,
        weight_trajectory: float = 0.25,
        weight_consistency: float = 0.15,
        spatial_decay_scale_km: float = 8.0,
        temporal_decay_scale_hours: float = 3.5
    ):
        self.w_spatial = weight_spatial
        self.w_temporal = weight_temporal
        self.w_trajectory = weight_trajectory
        self.w_consistency = weight_consistency
        self.spatial_decay = spatial_decay_scale_km
        self.temporal_decay = temporal_decay_scale_hours

        # Normalize weights to sum to 1.0
        total_w = self.w_spatial + self.w_temporal + self.w_trajectory + self.w_consistency
        if total_w > 0:
            self.w_spatial /= total_w
            self.w_temporal /= total_w
            self.w_trajectory /= total_w
            self.w_consistency /= total_w

    def score_vessel(
        self,
        trajectory: Dict[str, Any],
        origin_uncertainty_radius_km: float
    ) -> Dict[str, Any]:
        """
        Computes normalized factor scores and composite candidate score for a single vessel.
        """
        d_min = trajectory["min_distance_to_origin_km"]
        dt_hours = trajectory["time_delta_to_release_window_hours"]
        intersects = trajectory["intersects_origin_zone"]
        cpa_speed = trajectory["cpa_speed_knots"]
        avg_speed = trajectory["average_speed_knots"]
        vessel_type = str(trajectory.get("vessel_type", "")).lower()

        # 1. Spatial Proximity Score [0.0 - 1.0]
        # Exponential decay with distance from origin centroid
        s_spatial = math.exp(-d_min / self.spatial_decay)

        # 2. Temporal Alignment Score [0.0 - 1.0]
        # If vessel passed exactly during estimated release window: 1.0; decaying with temporal gap
        s_temporal = math.exp(-dt_hours / self.temporal_decay)

        # 3. Trajectory Intersection Score [0.0 - 1.0]
        if intersects:
            # Trajectory directly penetrates uncertainty envelope
            penetration_ratio = max(0.0, min(1.0, (origin_uncertainty_radius_km - d_min) / max(0.1, origin_uncertainty_radius_km)))
            s_trajectory = 0.85 + 0.15 * penetration_ratio
        else:
            # Near-miss margin
            miss_dist = max(0.0, d_min - origin_uncertainty_radius_km)
            s_trajectory = math.exp(-miss_dist / 4.0) * 0.70

        # 4. Kinematic & Vessel Type Consistency Score [0.0 - 1.0]
        # Realistic transit speeds (6 - 16 knots) + speed variation during discharge + vessel type relevance
        speed_score = 0.80
        if 5.0 <= cpa_speed <= 18.0:
            speed_score = 0.95
        elif cpa_speed < 2.0:
            speed_score = 0.70  # Anchored or drifting

        # Type risk heuristic
        type_bonus = 0.0
        if any(kw in vessel_type for kw in ["tanker", "crude", "chemical", "bunker", "oil"]):
            type_bonus = 0.15
        elif any(kw in vessel_type for kw in ["cargo", "container", "bulk"]):
            type_bonus = 0.08

        s_consistency = min(1.0, speed_score + type_bonus)

        # Total Composite Candidate Score
        total_score = (
            self.w_spatial * s_spatial +
            self.w_temporal * s_temporal +
            self.w_trajectory * s_trajectory +
            self.w_consistency * s_consistency
        )
        total_score = round(max(0.0, min(1.0, total_score)), 3)

        # Assign risk tier
        if total_score >= 0.75:
            priority_level = "HIGH PRIORITY CANDIDATE"
            priority_color = "red"
        elif total_score >= 0.50:
            priority_level = "MEDIUM PRIORITY CANDIDATE"
            priority_color = "amber"
        else:
            priority_level = "LOW PRIORITY"
            priority_color = "slate"

        # Generate Explainable Evidence Narrative
        narrative_points = []
        narrative_points.append(
            f"Spatial Proximity: Closest approach was {d_min:.2f} km from probable origin centroid (Spatial Score: {s_spatial:.2f})."
        )
        if dt_hours == 0.0:
            narrative_points.append(
                f"Temporal Alignment: Vessel passage coincided directly with estimated release time window (Temporal Score: {s_temporal:.2f})."
            )
        else:
            narrative_points.append(
                f"Temporal Alignment: Closest passage occurred {dt_hours:.1f} hrs offset from nominal release window (Temporal Score: {s_temporal:.2f})."
            )
        
        if intersects:
            narrative_points.append(
                f"Trajectory Geometry: Vessel track directly intersected the {origin_uncertainty_radius_km:.1f} km origin uncertainty envelope (Trajectory Score: {s_trajectory:.2f})."
            )
        else:
            narrative_points.append(
                f"Trajectory Geometry: Vessel track bypassed the origin uncertainty envelope by {d_min - origin_uncertainty_radius_km:.2f} km (Trajectory Score: {s_trajectory:.2f})."
            )

        narrative_points.append(
            f"Vessel Profile: Classified as '{trajectory.get('vessel_type')}' traveling at {cpa_speed:.1f} kn (Consistency Score: {s_consistency:.2f})."
        )

        return {
            "mmsi": trajectory["mmsi"],
            "vessel_name": trajectory["vessel_name"],
            "vessel_type": trajectory["vessel_type"],
            "imo": trajectory["imo"],
            "flag": trajectory["flag"],
            "length_m": trajectory["length_m"],
            "composite_score": total_score,
            "priority_level": priority_level,
            "priority_color": priority_color,
            "feature_breakdown": {
                "spatial_proximity_score": round(s_spatial, 3),
                "temporal_alignment_score": round(s_temporal, 3),
                "trajectory_intersection_score": round(s_trajectory, 3),
                "kinematic_consistency_score": round(s_consistency, 3),
                "weights_used": {
                    "spatial": round(self.w_spatial, 2),
                    "temporal": round(self.w_temporal, 2),
                    "trajectory": round(self.w_trajectory, 2),
                    "consistency": round(self.w_consistency, 2)
                }
            },
            "metrics": {
                "min_distance_to_origin_km": d_min,
                "time_delta_hours": dt_hours,
                "cpa_timestamp": trajectory["cpa_timestamp"],
                "cpa_speed_knots": cpa_speed,
                "cpa_coordinates": trajectory["cpa_coordinates"],
                "intersects_origin": intersects
            },
            "evidence_narrative": narrative_points,
            "scientific_disclaimer": (
                f"Decision-support ranking only. Vessel {trajectory['vessel_name']} (MMSI: {trajectory['mmsi']}) "
                f"is categorized as a {priority_level} based on spatio-temporal correlation. "
                "This does NOT constitute legal or definitive attribution of discharge responsibility."
            )
        }

    def rank_candidates(
        self,
        trajectories: List[Dict[str, Any]],
        origin_uncertainty_radius_km: float
    ) -> List[Dict[str, Any]]:
        """
        Scores and ranks all candidate vessels in descending order of composite attribution score.
        """
        scored_vessels = []
        for traj in trajectories:
            score_data = self.score_vessel(traj, origin_uncertainty_radius_km)
            # Attach full track for map visualization
            score_data["track_coordinates"] = traj["track_coordinates"]
            scored_vessels.append(score_data)

        # Sort descending by score
        scored_vessels.sort(key=lambda x: x["composite_score"], reverse=True)

        # Add rank
        for idx, vessel in enumerate(scored_vessels):
            vessel["rank"] = idx + 1

        return scored_vessels
