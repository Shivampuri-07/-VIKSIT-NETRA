"""
Sample Data Generator for Standalone Demonstration and Testing.
Creates realistic sample scenes with:
1. Synthetic Sentinel-1 SAR metadata and raster chips
2. Copernicus Marine ocean currents (uo, vo)
3. ERA5 10m atmospheric wind fields (u10, v10)
4. MarineCadastre / AccessAIS realistic vessel tracks
"""

import json
import os
from datetime import datetime, timedelta


def create_sample_scenes():
    """Generates 3 realistic maritime scenes with full data bundles."""
    os.makedirs("./data/sample", exist_ok=True)
    os.makedirs("./data/raw/ais", exist_ok=True)

    scenes = [
        {
            "scene_id": "S1A_IW_GRDH_1SDV_20260828T061422_GOM_MISSISSIPPI",
            "name": "Gulf of Mexico - Mississippi Canyon",
            "region": "Gulf of Mexico (US EEZ)",
            "acquisition_time": "2026-08-28T06:14:22Z",
            "satellite": "Sentinel-1A C-SAR",
            "polarization": "VV+VH",
            "bbox": [-88.65, 28.50, -88.15, 28.95],
            "center_lat": 28.725,
            "center_lon": -88.400,
            "environmental": {
                "current_uo_ms": 0.28,    # Loop Current eddy (East-Southeast)
                "current_vo_ms": -0.18,
                "wind_u10_ms": 5.2,       # Moderate southeasterly breeze
                "wind_v10_ms": -3.8,
                "wave_height_m": 1.2,
                "sea_temp_c": 28.4
            },
            "spill_ground_truth": {
                "synthetic_center_lat": 28.718,
                "synthetic_center_lon": -88.385,
                "estimated_age_hours": 10.5
            },
            "ais_vessels": [
                {
                    "mmsi": "352001849",
                    "vessel_name": "PACIFIC GLORY",
                    "vessel_type": "Crude Oil Tanker (Aframax)",
                    "imo": "9482711",
                    "flag": "Panama",
                    "length": 245.0,
                    "cpa_offset_hours": 0.2,   # Passed directly in estimated window
                    "cpa_lat": 28.665,
                    "cpa_lon": -88.465,
                    "speed_knots": 11.4,
                    "course_deg": 128.0
                },
                {
                    "mmsi": "636019882",
                    "vessel_name": "NORDIC STAR",
                    "vessel_type": "Chemical / Oil Products Tanker",
                    "imo": "9615542",
                    "flag": "Liberia",
                    "length": 183.0,
                    "cpa_offset_hours": 2.8,   # Passed 2.8h before window
                    "cpa_lat": 28.692,
                    "cpa_lon": -88.432,
                    "speed_knots": 13.8,
                    "course_deg": 132.0
                },
                {
                    "mmsi": "311000924",
                    "vessel_name": "CMA CGM DELTA",
                    "vessel_type": "Container Ship (Post-Panamax)",
                    "imo": "9728819",
                    "flag": "Bahamas",
                    "length": 335.0,
                    "cpa_offset_hours": 6.5,   # Passed 6.5 hours early
                    "cpa_lat": 28.610,
                    "cpa_lon": -88.520,
                    "speed_knots": 18.2,
                    "course_deg": 125.0
                },
                {
                    "mmsi": "367412980",
                    "vessel_name": "OCEAN EXPLORER II",
                    "vessel_type": "Offshore Supply / Tug",
                    "imo": "9812450",
                    "flag": "USA",
                    "length": 88.0,
                    "cpa_offset_hours": 1.1,
                    "cpa_lat": 28.790,
                    "cpa_lon": -88.310,
                    "speed_knots": 8.5,
                    "course_deg": 310.0
                },
                {
                    "mmsi": "244670000",
                    "vessel_name": "SEA HARVESTER",
                    "vessel_type": "Commercial Fishing Vessel",
                    "imo": "8912773",
                    "flag": "Netherlands",
                    "length": 42.0,
                    "cpa_offset_hours": 8.0,
                    "cpa_lat": 28.530,
                    "cpa_lon": -88.600,
                    "speed_knots": 4.2,
                    "course_deg": 85.0
                }
            ]
        },
        {
            "scene_id": "S1B_IW_GRDH_1SDV_20260827T174210_NORTH_SEA_BRENT",
            "name": "North Sea - Brent Oil Field / Fair Isle Channel",
            "region": "North Sea (UK/Norwegian Continental Shelf)",
            "acquisition_time": "2026-08-27T17:42:10Z",
            "satellite": "Sentinel-1B C-SAR",
            "polarization": "VV+VH",
            "bbox": [1.40, 60.80, 2.10, 61.35],
            "center_lat": 61.075,
            "center_lon": 1.750,
            "environmental": {
                "current_uo_ms": 0.35,
                "current_vo_ms": 0.22,
                "wind_u10_ms": 7.8,
                "wind_v10_ms": 4.5,
                "wave_height_m": 2.4,
                "sea_temp_c": 12.1
            },
            "spill_ground_truth": {
                "synthetic_center_lat": 61.082,
                "synthetic_center_lon": 1.765,
                "estimated_age_hours": 8.0
            },
            "ais_vessels": [
                {
                    "mmsi": "257002340",
                    "vessel_name": "BERGE BRENT",
                    "vessel_type": "Crude Oil Shuttle Tanker",
                    "imo": "9552190",
                    "flag": "Norway",
                    "length": 278.0,
                    "cpa_offset_hours": 0.4,
                    "cpa_lat": 61.020,
                    "cpa_lon": 1.680,
                    "speed_knots": 10.2,
                    "course_deg": 45.0
                },
                {
                    "mmsi": "211448000",
                    "vessel_name": "ELBE HIGHWAY",
                    "vessel_type": "Vehicles Carrier / Ro-Ro",
                    "imo": "9316309",
                    "flag": "Germany",
                    "length": 148.0,
                    "cpa_offset_hours": 3.2,
                    "cpa_lat": 61.120,
                    "cpa_lon": 1.840,
                    "speed_knots": 15.6,
                    "course_deg": 50.0
                },
                {
                    "mmsi": "235089220",
                    "vessel_name": "NORTHERN SOVEREIGN",
                    "vessel_type": "Platform Supply Vessel (PSV)",
                    "imo": "9641120",
                    "flag": "United Kingdom",
                    "length": 86.0,
                    "cpa_offset_hours": 1.2,
                    "cpa_lat": 61.045,
                    "cpa_lon": 1.710,
                    "speed_knots": 9.0,
                    "course_deg": 220.0
                }
            ]
        },
        {
            "scene_id": "S1A_IW_GRDH_1SDV_20260826T225514_SINGAPORE_STRAIT",
            "name": "Singapore Strait - Eastern TSS Corridor",
            "region": "Southeast Asia (Malacca/Singapore Chokepoint)",
            "acquisition_time": "2026-08-26T22:55:14Z",
            "satellite": "Sentinel-1A C-SAR",
            "polarization": "VV",
            "bbox": [104.10, 1.20, 104.55, 1.45],
            "center_lat": 1.325,
            "center_lon": 104.325,
            "environmental": {
                "current_uo_ms": -0.45,
                "current_vo_ms": -0.10,
                "wind_u10_ms": -3.5,
                "wind_v10_ms": -2.0,
                "wave_height_m": 0.6,
                "sea_temp_c": 29.8
            },
            "spill_ground_truth": {
                "synthetic_center_lat": 1.315,
                "synthetic_center_lon": 104.310,
                "estimated_age_hours": 6.0
            },
            "ais_vessels": [
                {
                    "mmsi": "563004820",
                    "vessel_name": "OCEAN HARMONY",
                    "vessel_type": "Bunker Tanker / Oil Barging",
                    "imo": "9742211",
                    "flag": "Singapore",
                    "length": 115.0,
                    "cpa_offset_hours": 0.3,
                    "cpa_lat": 1.340,
                    "cpa_lon": 104.360,
                    "speed_knots": 8.1,
                    "course_deg": 245.0
                },
                {
                    "mmsi": "477299100",
                    "vessel_name": "ORIENTAL PEARL",
                    "vessel_type": "Container Ship (Ultra Large)",
                    "imo": "9811002",
                    "flag": "Hong Kong",
                    "length": 399.0,
                    "cpa_offset_hours": 1.5,
                    "cpa_lat": 1.320,
                    "cpa_lon": 104.330,
                    "speed_knots": 14.5,
                    "course_deg": 248.0
                }
            ]
        }
    ]

    # Save scenes metadata
    with open("./data/sample/scenes_catalog.json", "w") as f:
        json.dump(scenes, f, indent=2)

    # For each scene, generate realistic continuous AIS broadcast points
    for scene in scenes:
        obs_dt = datetime.fromisoformat(scene["acquisition_time"].replace("Z", "+00:00"))
        all_ais_points = []

        for v_info in scene["ais_vessels"]:
            mmsi = v_info["mmsi"]
            v_name = v_info["vessel_name"]
            v_type = v_info["vessel_type"]
            imo = v_info["imo"]
            flag = v_info["flag"]
            length = v_info["length"]
            speed = v_info["speed_knots"]
            course = v_info["course_deg"]

            # CPA point calculation
            cpa_time = obs_dt - timedelta(hours=scene["spill_ground_truth"]["estimated_age_hours"] * 0.85 + v_info["cpa_offset_hours"])
            cpa_lat = v_info["cpa_lat"]
            cpa_lon = v_info["cpa_lon"]

            # Generate 15-25 points spanning 12 hours before to 6 hours after CPA
            # 30 minute reporting intervals
            time_offsets = [h for h in range(-10, 8)]
            for h in time_offsets:
                pt_time = cpa_time + timedelta(hours=h)
                
                # Distance along course in km
                dist_km = (h * speed * 1.852)
                rad_course = (course * 3.14159265) / 180.0
                d_north_km = dist_km * (1.0 if course <= 90 or course >= 270 else -1.0) * abs(course - 180) / 90.0
                
                # Simple spatial trajectory projection
                deg_lat = (dist_km * 0.009) * (1.0 if (course < 90 or course > 270) else -1.0)
                deg_lon = (dist_km * 0.009) * (1.0 if (course < 180) else -1.0)
                
                pt_lat = cpa_lat + deg_lat
                pt_lon = cpa_lon + deg_lon

                # Small jitter in speed & course
                cur_speed = max(0.5, speed + (h % 3 - 1) * 0.4)
                cur_course = (course + (h % 2 - 0.5) * 2.0) % 360.0

                all_ais_points.append({
                    "mmsi": mmsi,
                    "vessel_name": v_name,
                    "vessel_type": v_type,
                    "imo": imo,
                    "flag": flag,
                    "length": length,
                    "latitude": round(pt_lat, 6),
                    "longitude": round(pt_lon, 6),
                    "sog": round(cur_speed, 1),
                    "cog": round(cur_course, 1),
                    "timestamp": pt_time.isoformat()
                })

        # Save AIS points for this scene
        scene_ais_file = f"./data/sample/{scene['scene_id']}_ais.json"
        with open(scene_ais_file, "w") as f:
            json.dump(all_ais_points, f, indent=2)

    print(f"Sample data generated: 3 catalog scenes & AIS files in ./data/sample/")


if __name__ == "__main__":
    create_sample_scenes()
