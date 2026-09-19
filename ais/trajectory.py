"""
AIS Data Ingestion, Spatial-Temporal Filtering, and Trajectory Reconstruction.
Reconstructs vessel movement paths from MarineCadastre / AccessAIS broadcast points.
Calculates trajectory metrics, Closest Point of Approach (CPA), and origin intersections.
"""

import math
from datetime import datetime
from typing import Dict, Any, List, Tuple, Optional
from gis.processing.geometry import haversine_distance


class AISTrajectoryEngine:
    """
    Ingests AIS broadcast points, performs coordinate cleaning, groups by MMSI,
    reconstructs continuous trajectories, and computes proximity to origin envelope.
    """
    def __init__(self, max_speed_knots: float = 45.0):
        self.max_speed_knots = max_speed_knots

    def clean_and_group(self, raw_points: List[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
        """
        Validates coordinates and timestamps, filtering out corrupt records,
        and groups records by vessel MMSI.
        """
        vessel_groups: Dict[str, List[Dict[str, Any]]] = {}

        for pt in raw_points:
            mmsi = str(pt.get("mmsi") or pt.get("MMSI") or "")
            if not mmsi:
                continue

            try:
                lat = float(pt.get("latitude") or pt.get("lat") or pt.get("LAT", 0.0))
                lon = float(pt.get("longitude") or pt.get("lon") or pt.get("LON", 0.0))
                sog = float(pt.get("sog") or pt.get("SOG") or pt.get("speed", 0.0))
                cog = float(pt.get("cog") or pt.get("COG") or pt.get("course", 0.0))
                
                raw_time = pt.get("timestamp") or pt.get("BaseDateTime") or pt.get("time", "")
                if isinstance(raw_time, (int, float)):
                    dt = datetime.utcfromtimestamp(raw_time)
                else:
                    dt = datetime.fromisoformat(str(raw_time).replace("Z", "+00:00"))
            except Exception:
                continue

            # Coordinate sanity checks
            if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
                continue
            if abs(lat) < 0.0001 and abs(lon) < 0.0001:  # Null island check
                continue
            if sog < 0.0 or sog > self.max_speed_knots:
                continue

            cleaned_record = {
                "mmsi": mmsi,
                "vessel_name": pt.get("vessel_name") or pt.get("VesselName") or f"Vessel-{mmsi[-4:]}",
                "vessel_type": pt.get("vessel_type") or pt.get("VesselType") or "Tanker / Cargo",
                "imo": pt.get("imo") or pt.get("IMO") or "",
                "flag": pt.get("flag") or pt.get("Flag") or "Panama",
                "length_m": float(pt.get("length") or pt.get("Length") or 185.0),
                "latitude": lat,
                "longitude": lon,
                "sog": sog,
                "cog": cog,
                "timestamp": dt,
                "timestamp_iso": dt.isoformat()
            }

            if mmsi not in vessel_groups:
                vessel_groups[mmsi] = []
            vessel_groups[mmsi].append(cleaned_record)

        # Sort each vessel track chronologically
        for mmsi in vessel_groups:
            vessel_groups[mmsi].sort(key=lambda x: x["timestamp"])

        return vessel_groups

    def reconstruct_trajectories(
        self,
        raw_points: List[Dict[str, Any]],
        origin_centroid: Tuple[float, float],  # (lat, lon)
        origin_uncertainty_radius_km: float,
        release_window_start: str,
        release_window_end: str
    ) -> List[Dict[str, Any]]:
        """
        Reconstructs track lines for all vessels and computes spatial-temporal distance to the spill origin.
        """
        groups = self.clean_and_group(raw_points)
        orig_lat, orig_lon = origin_centroid
        
        t_start = datetime.fromisoformat(release_window_start.replace("Z", "+00:00"))
        t_end = datetime.fromisoformat(release_window_end.replace("Z", "+00:00"))
        t_nominal = t_start + (t_end - t_start) / 2

        trajectories = []

        for mmsi, points in groups.items():
            if len(points) < 2:
                continue

            # Build line coordinates [lon, lat]
            coords: List[List[float]] = []
            distances_to_origin: List[float] = []
            speeds: List[float] = []
            courses: List[float] = []
            total_track_length_km = 0.0

            min_dist_km = 999999.0
            cpa_point = points[0]
            cpa_idx = 0

            for idx, pt in enumerate(points):
                lon, lat = pt["longitude"], pt["latitude"]
                coords.append([round(lon, 6), round(lat, 6)])
                speeds.append(pt["sog"])
                courses.append(pt["cog"])

                dist_to_orig = haversine_distance(lat, lon, orig_lat, orig_lon)
                distances_to_origin.append(dist_to_orig)

                if dist_to_orig < min_dist_km:
                    min_dist_km = dist_to_orig
                    cpa_point = pt
                    cpa_idx = idx

                if idx > 0:
                    prev = points[idx - 1]
                    seg_dist = haversine_distance(prev["latitude"], prev["longitude"], lat, lon)
                    total_track_length_km += seg_dist

            # Time delta between closest approach and estimated release window
            cpa_time = cpa_point["timestamp"]
            if cpa_time < t_start:
                time_delta_hours = (t_start - cpa_time).total_seconds() / 3600.0
            elif cpa_time > t_end:
                time_delta_hours = (cpa_time - t_end).total_seconds() / 3600.0
            else:
                time_delta_hours = 0.0  # Exactly within the window!

            # Check if trajectory intersects origin uncertainty circle
            intersects_uncertainty_zone = bool(min_dist_km <= origin_uncertainty_radius_km)

            # Speed change or anomaly near CPA
            near_cpa_speeds = [
                points[i]["sog"]
                for i in range(max(0, cpa_idx - 2), min(len(points), cpa_idx + 3))
            ]
            avg_speed_knots = float(np.mean(speeds)) if 'np' in globals() else sum(speeds)/len(speeds)
            cpa_speed_knots = float(cpa_point["sog"])

            trajectories.append({
                "mmsi": mmsi,
                "vessel_name": points[0]["vessel_name"],
                "vessel_type": points[0]["vessel_type"],
                "imo": points[0]["imo"],
                "flag": points[0]["flag"],
                "length_m": points[0]["length_m"],
                "track_coordinates": coords,
                "point_count": len(points),
                "total_track_length_km": round(total_track_length_km, 2),
                "average_speed_knots": round(avg_speed_knots, 2),
                "cpa_speed_knots": round(cpa_speed_knots, 2),
                "min_distance_to_origin_km": round(min_dist_km, 3),
                "cpa_timestamp": cpa_point["timestamp_iso"],
                "cpa_coordinates": [round(cpa_point["latitude"], 6), round(cpa_point["longitude"], 6)],
                "time_delta_to_release_window_hours": round(time_delta_hours, 2),
                "intersects_origin_zone": intersects_uncertainty_zone,
                "first_seen": points[0]["timestamp_iso"],
                "last_seen": points[-1]["timestamp_iso"]
            })

        return trajectories
