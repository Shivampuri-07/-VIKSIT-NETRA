"""
FastAPI Route Handlers for Oil Spill Detection & Attribution System.
"""

from typing import Dict, Any, List, Optional
from fastapi import APIRouter, HTTPException, Query, status

from backend.app.schemas.schemas import (
    SpillDetectionRequest, SpillDetectionResponse,
    DriftSimulationRequest, DriftSimulationResponse,
    CandidateRankingResponse, FullAnalysisRunRequest, FullAnalysisRunResponse
)
from backend.app.services.pipeline_service import pipeline_service

router = APIRouter()


@router.get("/health")
def health_check():
    """Health status and data mode verification."""
    cred_status = pipeline_service.validate_credentials()
    return {
        "status": "healthy",
        "service": "Sentinel-1 Oil Spill Detection & Attribution API",
        "mode": pipeline_service.data_mode,
        "model": pipeline_service.model_status(),
        "credentials": cred_status,
        "available_scenes": len(pipeline_service.get_scenes())
    }


@router.get("/model/status")
def model_status():
    """Returns checkpoint and runtime status for the deployed segmentation model."""
    return pipeline_service.model_status()


@router.get("/config/credentials-status")
def credentials_status():
    """Returns credential validation status for the active mode."""
    return pipeline_service.validate_credentials()


@router.post("/config/mode")
def set_app_mode(payload: Dict[str, str]):
    """Switches application mode between DEMO and REAL."""
    mode = payload.get("mode", "DEMO").upper()
    if mode not in ["DEMO", "REAL"]:
        raise HTTPException(status_code=400, detail="Invalid mode. Choose 'DEMO' or 'REAL'.")
    pipeline_service.data_mode = mode
    cred_status = pipeline_service.validate_credentials()
    return {
        "mode": pipeline_service.data_mode,
        "credentials": cred_status,
        "message": f"System switched to {mode} DATA MODE."
    }


@router.get("/scenes")
def list_scenes():
    """Returns available satellite SAR scenes."""
    return {"scenes": pipeline_service.get_scenes()}


@router.get("/scenes/{scene_id}")
def get_scene(scene_id: str):
    """Returns details and environmental parameters for a scene."""
    sc = pipeline_service.get_scene_by_id(scene_id)
    if not sc:
        raise HTTPException(status_code=404, detail="Scene not found")
    return sc


@router.post("/spills/detect", response_model=SpillDetectionResponse)
def detect_spill(req: SpillDetectionRequest):
    """Runs SAR U-Net / adaptive segmentation and returns spill polygon & geometry."""
    try:
        res = pipeline_service.detect_spill(
            scene_id=req.scene_id,
            confidence_threshold=req.confidence_threshold,
            polarization=req.polarization
        )
        return res
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Detection failed: {str(e)}")


@router.get("/spills/{spill_id}")
def get_spill(spill_id: int):
    """Retrieves detected spill record by ID."""
    spill = pipeline_service.spills.get(spill_id)
    if not spill:
        raise HTTPException(status_code=404, detail="Spill record not found")
    return spill


@router.post("/spills/{spill_id}/drift", response_model=DriftSimulationResponse)
def run_drift_simulation(spill_id: int, req: DriftSimulationRequest):
    """Executes Lagrangian particle drift backtracking or forward simulation."""
    try:
        res = pipeline_service.run_drift(
            spill_id=spill_id,
            mode=req.mode,
            drift_hours=req.drift_hours,
            timestep_minutes=req.timestep_minutes,
            num_particles=req.num_particles,
            current_uo=req.current_uo,
            current_vo=req.current_vo,
            wind_u=req.wind_u,
            wind_v=req.wind_v
        )
        return res
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Drift simulation failed: {str(e)}")


@router.get("/vessels/candidates", response_model=CandidateRankingResponse)
def get_candidate_vessels(
    spill_id: int = Query(..., description="ID of the detected spill"),
    simulation_id: Optional[int] = Query(None, description="Drift simulation ID"),
    weight_spatial: float = Query(0.35, ge=0.0, le=1.0),
    weight_temporal: float = Query(0.25, ge=0.0, le=1.0),
    weight_trajectory: float = Query(0.25, ge=0.0, le=1.0),
    weight_consistency: float = Query(0.15, ge=0.0, le=1.0)
):
    """Reconstructs AIS tracks and scores candidate vessels."""
    try:
        res = pipeline_service.rank_candidates(
            spill_id=spill_id,
            simulation_id=simulation_id,
            weight_spatial=weight_spatial,
            weight_temporal=weight_temporal,
            weight_trajectory=weight_trajectory,
            weight_consistency=weight_consistency
        )
        return res
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/analysis/run", response_model=FullAnalysisRunResponse)
def run_end_to_end_analysis(req: FullAnalysisRunRequest):
    """Automated end-to-end pipeline run from SAR scene to ranked vessel attribution."""
    try:
        res = pipeline_service.run_full_analysis(
            scene_id=req.scene_id,
            drift_hours=req.drift_hours,
            num_particles=req.num_particles,
            weight_spatial=req.weight_spatial,
            weight_temporal=req.weight_temporal,
            weight_trajectory=req.weight_trajectory,
            weight_consistency=req.weight_consistency
        )
        return res
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Analysis pipeline error: {str(e)}")


@router.get("/analysis/{analysis_id}")
def get_analysis_result(analysis_id: str):
    """Retrieves full analysis record by ID."""
    res = pipeline_service.analyses.get(analysis_id)
    if not res:
        raise HTTPException(status_code=404, detail="Analysis ID not found")
    return res


@router.get("/map/layers")
def get_map_layers(scene_id: str = Query(...)):
    """Returns GeoJSON layers for MapLibre / Leaflet visualization."""
    return pipeline_service.get_map_layers(scene_id)
