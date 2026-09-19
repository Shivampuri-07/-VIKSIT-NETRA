"""
Pydantic Schemas for Request/Response Validation in FastAPI.
"""

from typing import List, Dict, Any, Optional
from datetime import datetime

try:
    from pydantic import BaseModel, Field
except ImportError:
    # Minimal fallback class if pydantic not present
    class BaseModel:
        def __init__(self, **kwargs):
            for k, v in kwargs.items():
                setattr(self, k, v)
        def dict(self):
            return self.__dict__
    Field = lambda *args, **kwargs: None


class GeoJSONGeometry(BaseModel):
    type: str = "Polygon"
    coordinates: List[Any]


class SpillDetectionRequest(BaseModel):
    scene_id: str
    confidence_threshold: float = 0.48
    polarization: str = "VV"


class SpillGeometryDetails(BaseModel):
    has_detection: bool
    centroid: List[float]  # [lat, lon]
    area_km2: float
    area_hectares: float
    perimeter_km: float
    bbox: List[float]  # [min_lon, min_lat, max_lon, max_lat]
    coordinates: List[List[float]]
    orientation_deg: float
    confidence: float
    pixel_count: int


class SpillDetectionResponse(BaseModel):
    spill_id: int
    scene_id: str
    detection_time: str
    geometry: SpillGeometryDetails
    dataset_mode: str = "DEMO"
    disclaimer: str


class DriftSimulationRequest(BaseModel):
    spill_id: int
    mode: str = "BACKWARD"
    drift_hours: float = 12.0
    timestep_minutes: float = 30.0
    num_particles: int = 60
    current_uo: Optional[float] = None
    current_vo: Optional[float] = None
    wind_u: Optional[float] = None
    wind_v: Optional[float] = None


class ProbableOriginDetails(BaseModel):
    centroid: List[float]  # [lat, lon]
    uncertainty_radius_km: float
    uncertainty_polygon: List[List[float]]
    estimated_release_window: Dict[str, Any]


class DriftSimulationResponse(BaseModel):
    simulation_id: int
    spill_id: int
    mode: str
    simulation_duration_hours: float
    probable_origin: ProbableOriginDetails
    environmental_parameters: Dict[str, Any]
    particle_trajectories: List[List[List[float]]]
    disclaimer: str


class VesselScoreDetail(BaseModel):
    rank: int
    mmsi: str
    vessel_name: str
    vessel_type: str
    imo: Optional[str] = None
    flag: Optional[str] = None
    length_m: float
    composite_score: float
    priority_level: str
    priority_color: str
    feature_breakdown: Dict[str, Any]
    metrics: Dict[str, Any]
    evidence_narrative: List[str]
    scientific_disclaimer: str
    track_coordinates: List[List[float]]


class CandidateRankingResponse(BaseModel):
    spill_id: int
    scene_id: str
    analysis_timestamp: str
    total_candidates: int
    high_priority_count: int
    medium_priority_count: int
    top_candidates: List[VesselScoreDetail]
    weights_used: Dict[str, float]
    attribution_disclaimer: str


class FullAnalysisRunRequest(BaseModel):
    scene_id: str
    drift_hours: float = 12.0
    num_particles: int = 60
    weight_spatial: float = 0.35
    weight_temporal: float = 0.25
    weight_trajectory: float = 0.25
    weight_consistency: float = 0.15


class FullAnalysisRunResponse(BaseModel):
    analysis_id: str
    scene_id: str
    timestamp: str
    status: str
    app_mode: str
    detection: SpillDetectionResponse
    drift: DriftSimulationResponse
    attribution: CandidateRankingResponse
