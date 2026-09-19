/**
 * Adapters that turn engine outputs into the response shapes the existing
 * UI already understands (DriftSimulation / CandidateRanking), so the new
 * engines could be introduced without breaking the frontend contract.
 *
 * Type-only imports: this file is safe to import from the browser bundle.
 */

import type { DriftResult } from "./drift";
import type { AttributionResult } from "./attribution";

export interface LegacyEnvSummary {
  wind_u10_ms: number | null;
  wind_v10_ms: number | null;
  wind_speed_ms: number | null;
  wind_direction_to_deg: number | null;
  wind_direction_from_deg: number | null;
  wind_status: string;
  current_uo_ms: number | null;
  current_vo_ms: number | null;
  current_speed_ms: number | null;
  current_status: string;
  wind_slick_axis_difference_deg: number | null;
  wind_slick_consistency: number | null;
  wind_source_label: string;
  current_source_label: string;
}

export function envSummaryFromInvestigation(environment: any): LegacyEnvSummary {
  const a = environment?.at_observation ?? {};
  return {
    wind_u10_ms: a.wind_u10_ms ?? null,
    wind_v10_ms: a.wind_v10_ms ?? null,
    wind_speed_ms: a.wind_speed_ms ?? null,
    wind_direction_to_deg: a.wind_direction_to_deg ?? null,
    wind_direction_from_deg: a.wind_direction_from_deg ?? null,
    wind_status: a.wind_status ?? "NOT_AVAILABLE",
    current_uo_ms: a.current_uo_ms ?? null,
    current_vo_ms: a.current_vo_ms ?? null,
    current_speed_ms: a.current_speed_ms ?? null,
    current_status: a.current_status ?? "NOT_AVAILABLE",
    wind_slick_axis_difference_deg: environment?.wind_slick_axis_difference_deg ?? null,
    wind_slick_consistency: environment?.wind_slick_consistency ?? null,
    wind_source_label: environment?.sources?.wind?.label ?? "unknown",
    current_source_label: environment?.sources?.current?.label ?? "unknown",
  };
}

const kn = (ms: number | null) => (ms === null ? null : Math.round(ms * 1.943844 * 100) / 100);

export function toLegacyDrift(
  sim: DriftResult,
  ids: { simulation_id: number | string; spill_id: number },
  env: LegacyEnvSummary,
  slickAxisDeg: number,
  realData: boolean,
) {
  const backward = sim.mode === "BACKWARD";
  const f = sim.final;
  return {
    simulation_id: ids.simulation_id,
    spill_id: ids.spill_id,
    mode: sim.mode,
    simulation_duration_hours: sim.hours,
    probable_origin: backward
      ? {
          centroid: f.centroid,
          uncertainty_radius_km: f.r90_km,
          uncertainty_polygon: f.hull,
          estimated_release_window: {
            start_time: sim.end_time,
            end_time: sim.start_time,
            nominal_hours_ago: sim.hours,
            window_type: "ANALYST_SET_BACKTRACK_HORIZON",
            note: "Release time is not estimated by the model; this is the analyst-selected backtrack horizon.",
          },
        }
      : null,
    forecast: backward
      ? null
      : { centroid: f.centroid, r90_km: f.r90_km, envelope: f.hull, horizon_hours: sim.hours, snapshots: sim.snapshots },
    environmental_parameters: {
      surface_current_uo_ms: env.current_uo_ms,
      surface_current_vo_ms: env.current_vo_ms,
      current_speed_knots: kn(env.current_speed_ms),
      current_status: env.current_status,
      wind_10m_u_ms: env.wind_u10_ms,
      wind_10m_v_ms: env.wind_v10_ms,
      wind_speed_knots: kn(env.wind_speed_ms),
      wind_direction_to_deg: env.wind_direction_to_deg,
      wind_direction_from_deg: env.wind_direction_from_deg,
      wind_status: env.wind_status,
      wind_leeway_factor: sim.forcing.wind_factor,
      eddy_diffusivity_m2s: sim.forcing.eddy_diffusivity_m2s,
      unknown_current_prior_sigma_ms: sim.forcing.unknown_current_prior_sigma_ms,
    },
    particle_trajectories: sim.tracks,
    environmental_consistency: {
      mean_wind_speed_ms: env.wind_speed_ms,
      mean_wind_direction_to_deg: env.wind_direction_to_deg,
      slick_axis_deg: slickAxisDeg,
      wind_slick_difference_deg: env.wind_slick_axis_difference_deg,
      wind_consistency_score: env.wind_slick_consistency === null ? null : Math.round(env.wind_slick_consistency * 1000) / 10,
      drift_consistency_score: env.wind_slick_consistency === null ? null : Math.round(env.wind_slick_consistency * 1000) / 10,
      method: "Axial difference between the ERA5 wind direction (compass, toward) at T0 and the slick principal axis; score = 1 - diff/90.",
    },
    real_data: realData,
    data_source: `${env.wind_source_label} [${env.wind_status}]; ${env.current_source_label} [${env.current_status}]`,
    disclaimer:
      "Lagrangian particle ensemble. Envelopes are P90 particle hulls of surface transport (no weathering). The origin is an uncertainty region, not a confirmed discharge location.",
    warnings: sim.warnings,
    engine: sim,
  };
}

export function toLegacyAttribution(
  att: AttributionResult,
  ids: { spill_id: number; scene_id: string },
  env: LegacyEnvSummary,
  slickAxisDeg: number,
  ais: { source: string; records: number; synthetic: boolean },
) {
  return {
    spill_id: ids.spill_id,
    scene_id: ids.scene_id,
    analysis_timestamp: new Date().toISOString(),
    total_candidates: att.total_candidates,
    high_priority_count: att.high_priority_count,
    medium_priority_count: att.medium_priority_count,
    top_candidates: att.candidates,
    weights_used: att.weights_used,
    factor_definitions: att.factor_definitions,
    coverage_warnings: att.coverage_warnings,
    score_gap_top2: att.score_gap_top2,
    environmental_consistency: {
      mean_wind_speed_ms: env.wind_speed_ms,
      mean_wind_direction_to_deg: env.wind_direction_to_deg,
      slick_axis_deg: slickAxisDeg,
      wind_slick_difference_deg: env.wind_slick_axis_difference_deg,
      wind_consistency_score: env.wind_slick_consistency === null ? null : Math.round(env.wind_slick_consistency * 1000) / 10,
      drift_consistency_score: env.wind_slick_consistency === null ? null : Math.round(env.wind_slick_consistency * 1000) / 10,
      data_source: env.wind_source_label,
    },
    ais_data_source: ais.source,
    ais_record_count: ais.records,
    real_data: !ais.synthetic,
    attribution_disclaimer:
      "ATTRIBUTION DECISION-SUPPORT NOTICE: Candidates are ranked by spatio-temporal and kinematic compatibility with the observed slick and a modelled drift corridor. A high-priority candidate is an investigative lead only and does NOT constitute legal, scientific or definitive attribution of an oil discharge.",
  };
}
