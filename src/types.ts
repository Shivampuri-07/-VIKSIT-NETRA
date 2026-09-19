/**
 * Frontend types. Engine result types are imported (type-only) from the
 * server engines so the browser and server can never drift apart.
 */
export type { DriftResult, DriftSnapshot, CentroidPathPoint } from "../server/lib/drift";
export type { NodeEvent, NodeStatus, Hypothesis, EvidenceItem } from "../server/lib/investigation";
import type { DriftResult } from "../server/lib/drift";
import type { NodeEvent, NodeStatus, Hypothesis } from "../server/lib/investigation";

export interface Scene {
  scene_id: string;
  name: string;
  region: string;
  acquisition_time: string;
  satellite: string;
  polarization: string;
  bbox: [number, number, number, number];
  center_lat: number;
  center_lon: number;
  environmental: {
    current_uo_ms: number | null;
    current_vo_ms: number | null;
    wind_u10_ms: number | null;
    wind_v10_ms: number | null;
    wave_height_m: number | null;
    sea_temp_c: number | null;
  };
  data_source?: string;
  real_data?: boolean;
  synthetic?: boolean;
  data_status?: string;
  ml_model?: string;
  ml_dataset?: string;
  notes?: string[];
}

export interface SpillGeometry {
  has_detection: boolean;
  centroid: [number, number];
  area_km2: number;
  area_hectares: number;
  perimeter_km: number;
  bbox: [number, number, number, number];
  coordinates: number[][];
  orientation_deg: number;
  orientation_source?: string;
  polygon_principal_axis_deg?: number;
  elongation?: number;
  confidence: number | null;
  pixel_count: number | null;
  /** every retained polygon (largest first); `coordinates` is parts[0] */
  parts?: [number, number][][];
  n_components?: number | null;
  area_basis?: string;
}

export interface SpillDetection {
  spill_id: number;
  scene_id: string;
  detection_time: string;
  geometry: SpillGeometry;
  geometry_source?: string;
  geometry_source_detail?: string;
  dataset_mode: string;
  polarization: string;
  disclaimer: string;
  data_source?: string;
  ml_model?: Record<string, any>;
  benchmark?: Record<string, any>;
  segmentation_quality?: Record<string, any>;
  prediction_provenance?: Record<string, any> | null;
  reference_label?: { provenance: string; evaluation_only: boolean; note: string; area_km2: number; pixel_count: number; centroid: [number, number] | null; orientation_deg: number | null; parts: [number, number][][] } | null;
  derived_geometry_status?: string;
  real_data?: boolean;
  synthetic?: boolean;
}

export interface ProbableOrigin {
  centroid: [number, number];
  uncertainty_radius_km: number;
  uncertainty_polygon: number[][];
  estimated_release_window: {
    start_time: string;
    end_time: string;
    nominal_hours_ago: number;
    window_type?: string;
    note?: string;
  };
}

export interface DriftSimulation {
  simulation_id: number | string;
  spill_id: number;
  mode: string;
  simulation_duration_hours: number;
  probable_origin: ProbableOrigin | null;
  environmental_parameters: {
    surface_current_uo_ms: number | null;
    surface_current_vo_ms: number | null;
    current_speed_knots: number | null;
    current_status?: string;
    wind_10m_u_ms: number | null;
    wind_10m_v_ms: number | null;
    wind_speed_knots: number | null;
    wind_direction_to_deg?: number | null;
    wind_direction_from_deg?: number | null;
    wind_status?: string;
    wind_leeway_factor: number;
    eddy_diffusivity_m2s: number;
    unknown_current_prior_sigma_ms?: number;
  };
  particle_trajectories: number[][][];
  disclaimer: string;
  data_source?: string;
  environmental_consistency?: {
    mean_wind_speed_ms: number | null;
    mean_wind_direction_to_deg: number | null;
    slick_axis_deg: number;
    wind_slick_difference_deg: number | null;
    wind_consistency_score: number | null;
    drift_consistency_score: number | null;
    method?: string;
  };
  real_data?: boolean;
  warnings?: string[];
  engine?: DriftResult;
}

export interface FactorWeights {
  spatial: number;
  temporal: number;
  trajectory: number;
  consistency: number;
}

export interface VesselScoreDetail {
  rank: number;
  mmsi: string;
  vessel_name: string;
  vessel_type: string;
  imo?: string;
  flag?: string;
  length_m: number | null;
  width_m?: number | null;
  synthetic?: boolean;
  composite_score: number;
  priority_level: "HIGH PRIORITY CANDIDATE" | "MEDIUM PRIORITY CANDIDATE" | "LOW PRIORITY";
  priority_color: "red" | "amber" | "slate";
  feature_breakdown: {
    spatial_proximity_score: number;
    temporal_alignment_score: number;
    trajectory_intersection_score: number;
    kinematic_consistency_score: number;
    weights_used: FactorWeights;
    weighted_contributions?: FactorWeights;
  };
  metrics: {
    min_distance_to_origin_km: number;
    min_distance_to_slick_km?: number;
    min_distance_to_slick_centroid_km?: number;
    time_delta_hours: number;
    cpa_timestamp: string;
    cpa_speed_knots: number;
    cpa_course_deg?: number | null;
    cpa_coordinates: [number, number];
    course_slick_axis_difference_deg?: number | null;
    intersects_origin: boolean;
    corridor_min_distance_km?: number | null;
    corridor_r90_at_best_km?: number | null;
    corridor_best_time?: string | null;
    corridor_samples_with_position?: number;
  };
  ais_quality?: {
    n_points: number;
    n_points_in_window: number;
    first_report: string;
    last_report: string;
    median_interval_min: number | null;
    max_gap_in_window_min: number | null;
    window_coverage_fraction: number;
    implied_speed_outliers: number;
    quality_label: "GOOD" | "FAIR" | "POOR";
  };
  baseline_offline_score?: number | null;
  why_priority?: string[];
  contradicting_evidence?: string[];
  evidence_narrative: string[];
  sensitivity?: {
    rank_without_spatial: number;
    rank_without_temporal: number;
    rank_without_trajectory: number;
    rank_without_kinematic: number;
    rank_min: number;
    rank_max: number;
    stable: boolean;
  };
  explanation?: { method: string; base_value: number; contributions: FactorWeights; additivity_error: number };
  scientific_disclaimer: string;
  track_coordinates: number[][];
  environmental_drift_score?: number;
  ais_slick_difference_deg?: number;
  causality_status?: string;
}

export interface CandidateRanking {
  spill_id: number;
  scene_id: string;
  analysis_timestamp: string;
  total_candidates: number;
  high_priority_count: number;
  medium_priority_count: number;
  top_candidates: VesselScoreDetail[];
  weights_used: FactorWeights;
  attribution_disclaimer: string;
  factor_definitions?: Record<string, string>;
  coverage_warnings?: string[];
  score_gap_top2?: number | null;
  environmental_consistency?: {
    mean_wind_speed_ms: number | null;
    mean_wind_direction_to_deg: number | null;
    slick_axis_deg: number;
    wind_slick_difference_deg: number | null;
    wind_consistency_score: number | null;
    drift_consistency_score: number | null;
    data_source: string;
  };
  ais_data_source?: string;
  ais_record_count?: number;
  real_data?: boolean;
}

export interface GridVector {
  lat: number;
  lon: number;
  u: number;
  v: number;
  speed_ms: number;
  direction_to_deg: number;
  direction_from_deg: number;
  status: string;
}

export interface EnvironmentState {
  at_observation: {
    time: string;
    wind_u10_ms: number;
    wind_v10_ms: number;
    wind_speed_ms: number;
    wind_speed_knots: number;
    wind_direction_to_deg: number;
    wind_direction_from_deg: number;
    wind_status: string;
    current_uo_ms: number | null;
    current_vo_ms: number | null;
    current_speed_ms: number | null;
    current_direction_to_deg: number | null;
    current_status: string;
  };
  wind_slick_axis_difference_deg: number;
  wind_slick_consistency: number;
  low_wind_lookalike_risk: boolean;
  coverage: { backward_window_fraction: number | null; forward_window_fraction: number | null };
  wind_grid_at_observation: GridVector[];
  current_grid_at_observation: GridVector[];
  wind_time_series: { time: string; u: number; v: number; speed_ms: number; direction_to_deg: number; direction_from_deg: number; status: string }[];
  current_time_series: { time: string; u: number; v: number; speed_ms: number; direction_to_deg: number; direction_from_deg: number; status: string }[];
  sources: { wind: any; current: any };
}

export interface GraphNodeInfo {
  id: string;
  label: string;
  stage?: string | null;
  kind?: string;
  description: string;
  requires: string[];
  conditional: boolean;
  status: NodeStatus;
}

export interface InvestigationView {
  investigation_id: string;
  status: "running" | "completed" | "failed";
  created_at: string;
  updated_at: string;
  graph: {
    runtime: string;
    orchestrator?: "deterministic" | "langgraph";
    orchestrator_status?: "LANGGRAPH" | "DETERMINISTIC_FALLBACK";
    orchestrator_info?: {
      status: "LANGGRAPH" | "DETERMINISTIC_FALLBACK";
      requested: string;
      package: string | null;
      package_version: string | null;
      core_version: string | null;
      graph_node_invocations: number;
      llm_used: false;
      node_kind: "RULE_BASED_COMPUTATION";
      note: string | null;
    } | null;
    stages?: string[];
    nodes: GraphNodeInfo[];
  };
  events: NodeEvent[];
  state: {
    params: any;
    scene?: Scene;
    detection?: SpillDetection;
    characterization?: Record<string, any>;
    environment?: EnvironmentState;
    backward?: DriftResult;
    forward?: DriftResult;
    ais?: { source: string; file: string; records: number; vessels: number; vessels_active_in_window: number; spatial_extent: number[] | null; synthetic: boolean };
    attribution?: any;
    evidence_graph?: { nodes: any[]; edges: any[] };
    hypotheses?: Hypothesis[];
    uncertainty?: { overall: string; components: { component: string; level: string; value: any; basis: string }[]; note: string };
    risk?: { level: string; color: string; rationale: string; factors: { name: string; value: string; category: string }[]; exposure_assessed: boolean; method: string };
    recommendations?: { priority: "IMMEDIATE" | "HIGH" | "ROUTINE"; action: string; rationale: string }[];
    report?: { incident_id: string; investigation_id: string; generated_at: string; disclaimer: string; sections_available: Record<string, boolean> };
    warnings: string[];
  };
}

export interface DriftSettings {
  driftHours: number;
  numParticles: number;
  windFactor: number;
  eddyDiffusivity: number;
  unknownCurrentSigma: number;
}
