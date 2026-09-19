"""
SQLAlchemy Database Models for Oil Spill Detection & Attribution System.
Supports standard SQLite for lightweight local demo, as well as PostgreSQL/PostGIS.
"""

import json
from datetime import datetime
from typing import Dict, Any, Optional

try:
    from sqlalchemy import Column, Integer, String, Float, DateTime, Text, Boolean, create_engine
    from sqlalchemy.orm import declarative_base, sessionmaker
    HAS_SQLALCHEMY = True
    Base = declarative_base()
except ImportError:
    HAS_SQLALCHEMY = False
    Base = object


if HAS_SQLALCHEMY:
    class SatelliteScene(Base):
        __tablename__ = "satellite_scenes"

        id = Column(Integer, primary_key=True, index=True)
        scene_id = Column(String(128), unique=True, index=True, nullable=False)
        name = Column(String(256), nullable=False)
        region = Column(String(256), nullable=False)
        sensor = Column(String(64), default="Sentinel-1 C-SAR")
        acquisition_time = Column(DateTime, nullable=False)
        bbox_min_lon = Column(Float, nullable=False)
        bbox_min_lat = Column(Float, nullable=False)
        bbox_max_lon = Column(Float, nullable=False)
        bbox_max_lat = Column(Float, nullable=False)
        polarization = Column(String(32), default="VV+VH")
        created_at = Column(DateTime, default=datetime.utcnow)

    class SpillDetection(Base):
        __tablename__ = "spill_detections"

        id = Column(Integer, primary_key=True, index=True)
        scene_id = Column(String(128), index=True, nullable=False)
        detection_time = Column(DateTime, default=datetime.utcnow)
        centroid_lat = Column(Float, nullable=False)
        centroid_lon = Column(Float, nullable=False)
        area_km2 = Column(Float, nullable=False)
        area_hectares = Column(Float, nullable=False)
        perimeter_km = Column(Float, nullable=False)
        confidence = Column(Float, nullable=False)
        orientation_deg = Column(Float, default=0.0)
        polygon_geojson = Column(Text, nullable=False)
        created_at = Column(DateTime, default=datetime.utcnow)

    class DriftSimulation(Base):
        __tablename__ = "drift_simulations"

        id = Column(Integer, primary_key=True, index=True)
        spill_id = Column(Integer, index=True, nullable=False)
        mode = Column(String(32), default="BACKWARD")
        drift_hours = Column(Float, default=12.0)
        particle_count = Column(Integer, default=60)
        current_uo = Column(Float, default=0.25)
        current_vo = Column(Float, default=-0.15)
        wind_u = Column(Float, default=4.5)
        wind_v = Column(Float, default=-3.2)
        origin_lat = Column(Float, nullable=False)
        origin_lon = Column(Float, nullable=False)
        uncertainty_radius_km = Column(Float, nullable=False)
        release_window_start = Column(DateTime, nullable=False)
        release_window_end = Column(DateTime, nullable=False)
        trajectories_geojson = Column(Text, nullable=True)
        created_at = Column(DateTime, default=datetime.utcnow)

    class VesselCandidate(Base):
        __tablename__ = "vessel_candidates"

        id = Column(Integer, primary_key=True, index=True)
        spill_id = Column(Integer, index=True, nullable=False)
        mmsi = Column(String(32), index=True, nullable=False)
        vessel_name = Column(String(256), nullable=False)
        vessel_type = Column(String(128), default="Tanker")
        imo = Column(String(32), nullable=True)
        flag = Column(String(64), nullable=True)
        rank = Column(Integer, nullable=False)
        composite_score = Column(Float, nullable=False)
        priority_level = Column(String(64), nullable=False)
        spatial_score = Column(Float, nullable=False)
        temporal_score = Column(Float, nullable=False)
        trajectory_score = Column(Float, nullable=False)
        consistency_score = Column(Float, nullable=False)
        min_distance_km = Column(Float, nullable=False)
        time_delta_hours = Column(Float, nullable=False)
        narrative_json = Column(Text, nullable=True)
        created_at = Column(DateTime, default=datetime.utcnow)

    class AnalysisRun(Base):
        __tablename__ = "analysis_runs"

        id = Column(String(64), primary_key=True, index=True)
        scene_id = Column(String(128), index=True, nullable=False)
        timestamp = Column(DateTime, default=datetime.utcnow)
        status = Column(String(32), default="COMPLETED")
        app_mode = Column(String(32), default="DEMO")
        top_candidate_name = Column(String(256), nullable=True)
        top_candidate_mmsi = Column(String(32), nullable=True)
        top_candidate_score = Column(Float, nullable=True)
        summary_json = Column(Text, nullable=False)


def init_db(database_url: str = "sqlite:///./data/oil_spill.db"):
    """Initializes SQLite/PostGIS database tables."""
    if not HAS_SQLALCHEMY:
        print("[Database] SQLAlchemy not installed. Running in-memory store.")
        return None, None
    engine = create_engine(database_url, connect_args={"check_same_thread": False} if "sqlite" in database_url else {})
    Base.metadata.create_all(bind=engine)
    SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    return engine, SessionLocal
