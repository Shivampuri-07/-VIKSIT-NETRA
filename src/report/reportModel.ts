/**
 * Builds the incident-report content from the ACTUAL investigation state
 * returned by the server (plus UI selections). Pure and deterministic: no
 * DOM, no network, no invented values. Anything the investigation did not
 * produce is reported as unavailable.
 */

import type { InvestigationView, Scene, NodeEvent, Hypothesis, GridVector, DriftResult } from "../types";
import type { VesselEvidence, AttributionResult } from "../../server/lib/attribution";
import { fmt, fmtLat, fmtLon, fmtLatLon, utc } from "../lib/format";
import { provenanceCategory, ProvCategory } from "./palette";

export interface ReportImage {
  name: string;
  caption: string;
  bytes: Uint8Array | null; // JPEG
  error?: string;
}

export interface ReportInput {
  investigation: InvestigationView;
  scene?: Scene | null;
  selectedVesselMmsi?: string | null;
  forecastHorizon?: number | "ALL";
  counterfactuals?: any[];
  images?: ReportImage[];
  registry?: any | null;
  dataInventory?: { file: string; role: string; present: boolean }[] | null;
  generatedAt?: Date;
}

export interface Row { label: string; value: string | null; status?: string | null; note?: string; chip?: { dim: "risk" | "uncertainty"; level: string } }

export interface EnvRow extends Row { category: ProvCategory }

export interface ReportModel {
  generatedAt: string;
  incidentId: string;
  investigationId: string;
  investigationStatus: string;
  runtime: string;
  synthetic: boolean;
  scene: Scene | null;
  horizon: number | "ALL";
  selectedVessel: VesselEvidence | null;
  summary: Row[];
  detection: InvestigationView["state"]["detection"] | null;
  characterization: Record<string, any> | null;
  vertices: [number, number][];
  environment: {
    rows: EnvRow[];
    windowProvenance: { label: string; fractions: Record<string, number> }[];
    windGrid: GridVector[];
    windSeries: { time: string; speed_ms: number; direction_from_deg: number; direction_to_deg: number; status: string }[];
    coverage: { backward: number | null; forward: number | null };
    lookalike: boolean;
    windSlickDiff: number | null;
    currentAvailable: boolean;
    currentPriorSigma: number | null;
  } | null;
  backward: DriftResult | null;
  forward: DriftResult | null;
  forecastRows: { hours: number; time: string; centroid: string; displacement: string; r50: string; r90: string; area: string; windReal: string; currentReal: string; supported: boolean | null; supportReason: string; selected: boolean }[];
  ais: InvestigationView["state"]["ais"] | null;
  attribution: AttributionResult | null;
  attributionUncertainty: string;
  dossiers: VesselEvidence[];
  hypotheses: Hypothesis[];
  uncertainty: InvestigationView["state"]["uncertainty"] | null;
  risk: InvestigationView["state"]["risk"] | null;
  recommendations: NonNullable<InvestigationView["state"]["recommendations"]>;
  timeline: NodeEvent[];
  dataSources: Row[];
  limitations: string[];
  warnings: string[];
  missing: string[];
  disclaimers: string[];
  images: ReportImage[];
  counterfactuals: any[];
}

export const LEGAL_DISCLAIMER =
  "Vessel attribution in this report is PROBABILISTIC INVESTIGATIVE EVIDENCE, NOT LEGAL PROOF. Candidate vessels are ranked by spatio-temporal and kinematic compatibility of their AIS tracks with the observed slick and a modelled drift corridor. A high-priority candidate is an investigative lead only; establishing that any vessel discharged oil requires independent evidence such as physical sampling and oil fingerprinting, vessel records and a competent-authority investigation.";

const dedupe = (xs: string[]) => [...new Set(xs.filter((x) => !!x && String(x).trim()))];

function pct(x: number | null | undefined): string {
  return x === null || x === undefined || !Number.isFinite(x) ? "n/a" : `${Math.round(x * 100)} %`;
}

/** Status with the largest share of samples (e.g. PERSISTED when most drift steps used persisted wind). */
function dominantStatus(fr: Record<string, number> | undefined): string | null {
  if (!fr) return null;
  const e = Object.entries(fr).sort((a, b) => b[1] - a[1])[0];
  return e ? e[0] : null;
}

function fractionsText(fr: Record<string, number> | undefined): string {
  if (!fr) return "n/a";
  return Object.entries(fr).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${pct(v)}`).join(", ");
}

export function buildReportModel(input: ReportInput): ReportModel {
  const view = input.investigation;
  const s = view.state;
  const scene = s.scene ?? input.scene ?? null;
  const det = s.detection ?? null;
  const env = s.environment ?? null;
  const att = (s.attribution ?? null) as AttributionResult | null;
  const candidates = att?.candidates ?? [];
  const synthetic = !!(scene?.synthetic || det?.synthetic);
  const horizon = input.forecastHorizon ?? "ALL";
  const selectedVessel = candidates.find((c) => c.mmsi === input.selectedVesselMmsi) ?? null;
  const incidentId = s.report?.incident_id ?? `AEGIS-${(scene?.scene_id ?? s.params?.scene_id ?? "NA").slice(0, 24)}-${view.investigation_id.slice(-6)}`;
  const missing: string[] = [];

  // ------------------------------------------------------------ environment
  let environment: ReportModel["environment"] = null;
  if (env) {
    const a = env.at_observation;
    const windOk = a.wind_status !== "NOT_AVAILABLE";
    const curOk = a.current_status !== "NOT_AVAILABLE" && a.current_speed_ms !== null;
    const rows: EnvRow[] = [
      {
        label: "Wind 10 m (u10, v10)",
        value: windOk ? `u = ${fmt(a.wind_u10_ms, 3)} m/s, v = ${fmt(a.wind_v10_ms, 3)} m/s` : null,
        status: a.wind_status, category: provenanceCategory(a.wind_status),
        note: env.sources?.wind?.label,
      },
      {
        label: "Wind speed / direction at T0",
        value: windOk ? `${fmt(a.wind_speed_ms)} m/s (${fmt(a.wind_speed_knots, 1)} kn), from ${fmt(a.wind_direction_from_deg, 0)} deg, toward ${fmt(a.wind_direction_to_deg, 0)} deg` : null,
        status: a.wind_status, category: provenanceCategory(a.wind_status),
        note: a.wind_status === "REAL" ? "Interpolated between native ERA5 hourly fields at the slick centroid." : undefined,
      },
      {
        label: "Ocean surface current (uo, vo)",
        value: curOk ? `u = ${fmt(a.current_uo_ms, 3)} m/s, v = ${fmt(a.current_vo_ms, 3)} m/s; ${fmt(a.current_speed_ms)} m/s toward ${fmt(a.current_direction_to_deg, 0)} deg` : null,
        status: a.current_status, category: provenanceCategory(a.current_status),
        note: curOk ? env.sources?.current?.label : `${env.sources?.current?.label ?? "No product"}. No current value is reported because none was observed.`,
      },
      {
        label: "Sea-surface temperature",
        value: scene?.environmental?.sea_temp_c != null ? `${scene.environmental.sea_temp_c} deg C` : null,
        status: scene?.environmental?.sea_temp_c != null ? (synthetic ? "DEMO_CONSTANT" : "REAL") : "NOT_AVAILABLE",
        category: provenanceCategory(scene?.environmental?.sea_temp_c != null ? (synthetic ? "DEMO_CONSTANT" : "REAL") : "NOT_AVAILABLE"),
        note: "Not used by the drift engine.",
      },
      {
        label: "Significant wave height",
        value: scene?.environmental?.wave_height_m != null ? `${scene.environmental.wave_height_m} m` : null,
        status: scene?.environmental?.wave_height_m != null ? (synthetic ? "DEMO_CONSTANT" : "REAL") : "NOT_AVAILABLE",
        category: provenanceCategory(scene?.environmental?.wave_height_m != null ? (synthetic ? "DEMO_CONSTANT" : "REAL") : "NOT_AVAILABLE"),
        note: "Not used by the drift engine.",
      },
    ];
    const wp: { label: string; fractions: Record<string, number> }[] = [];
    if (s.backward) {
      wp.push({ label: `Wind over backtrack window (T-${s.backward.hours} h .. T0)`, fractions: s.backward.forcing.wind_status_fractions });
      wp.push({ label: "Current over backtrack window", fractions: s.backward.forcing.current_status_fractions });
    }
    if (s.forward) {
      wp.push({ label: `Wind over forecast window (T0 .. T+${s.forward.hours} h)`, fractions: s.forward.forcing.wind_status_fractions });
      wp.push({ label: "Current over forecast window", fractions: s.forward.forcing.current_status_fractions });
    }
    environment = {
      rows,
      windowProvenance: wp,
      windGrid: env.wind_grid_at_observation ?? [],
      windSeries: (env.wind_time_series ?? []).map((w) => ({ time: w.time, speed_ms: w.speed_ms, direction_from_deg: w.direction_from_deg, direction_to_deg: w.direction_to_deg, status: w.status })),
      coverage: { backward: env.coverage?.backward_window_fraction ?? null, forward: env.coverage?.forward_window_fraction ?? null },
      lookalike: !!env.low_wind_lookalike_risk,
      windSlickDiff: env.wind_slick_axis_difference_deg ?? null,
      currentAvailable: curOk,
      currentPriorSigma: s.backward?.forcing.current_prior_applied ? s.backward.forcing.unknown_current_prior_sigma_ms : null,
    };
  } else missing.push("Environmental analysis");

  if (!det) missing.push("Satellite detection / spill geometry");
  if (!s.backward) missing.push("Backward origin estimate");
  if (!s.forward) missing.push("Forward forecast / Future Impact Zone");
  if (!att) missing.push("AIS candidate ranking");
  if (!s.hypotheses) missing.push("Competing hypotheses");
  if (!s.uncertainty) missing.push("Uncertainty assessment");
  if (!s.risk) missing.push("Risk assessment");

  // ------------------------------------------------------------ forecast rows
  const forecastRows = (s.forward?.snapshots ?? []).map((sn) => ({
    hours: sn.hours,
    time: utc(sn.time),
    centroid: fmtLatLon(sn.centroid, 4),
    displacement: `${fmt(sn.displacement_km)} km toward ${fmt(sn.displacement_bearing_deg, 0)} deg`,
    r50: `${fmt(sn.r50_km)} km`,
    r90: `${fmt(sn.r90_km)} km`,
    area: `${fmt(sn.hull_area_km2, 1)} km2`,
    windReal: pct(sn.wind_real_fraction),
    currentReal: pct(sn.current_real_fraction),
    /** null = synthetic forcing; false = persistence scenario (real forcing coverage does not support a forecast) */
    supported: sn.forcing_support?.supported ?? null,
    supportReason: sn.forcing_support?.reason ?? "",
    selected: horizon === "ALL" || horizon === sn.hours,
  }));

  // ------------------------------------------------------------ attribution uncertainty
  const attUnc = s.uncertainty?.components?.find((c) => c.component === "Vessel attribution")?.level ?? "N/A";

  // ------------------------------------------------------------ dossiers: top 5 + selected
  const dossiers = candidates.slice(0, 5);
  if (selectedVessel && !dossiers.some((d) => d.mmsi === selectedVessel.mmsi)) dossiers.push(selectedVessel);

  // ------------------------------------------------------------ summary
  const a = env?.at_observation;
  const selSnap = s.forward?.snapshots.find((x) => x.hours === (horizon === "ALL" ? 24 : horizon)) ?? s.forward?.snapshots[s.forward.snapshots.length - 1];
  const top = candidates[0];
  const summary: Row[] = [
    { label: "Incident / investigation", value: `${incidentId} / ${view.investigation_id} (${view.status})` },
    { label: "Scene", value: scene ? `${scene.name}` : null, status: scene ? (synthetic ? "SYNTHETIC_DEMO" : "REAL") : null },
    { label: "Observation time (T0)", value: det ? utc(det.detection_time) : scene ? utc(scene.acquisition_time) : null },
    { label: "Satellite / polarisation", value: scene ? `${scene.satellite} / ${scene.polarization}` : null },
    { label: "Slick area", value: det ? `${fmt(det.geometry.area_km2)} km2 (${fmt(det.geometry.area_hectares, 0)} ha)` : null, status: det?.geometry_source ?? null },
    { label: "Slick centroid", value: det ? fmtLatLon(det.geometry.centroid, 4) : null },
    { label: "Wind at T0", value: a && a.wind_status !== "NOT_AVAILABLE" ? `${fmt(a.wind_speed_ms)} m/s from ${fmt(a.wind_direction_from_deg, 0)} deg` : null, status: a?.wind_status ?? "NOT_AVAILABLE",
      note: s.backward || s.forward ? `Provenance at the observation time only. Over the drift windows only ${pct(s.backward?.forcing.wind_status_fractions?.REAL ?? 0)} (backtrack) and ${pct(s.forward?.forcing.wind_status_fractions?.REAL ?? 0)} (forecast) of wind samples are REAL; see "Drift forcing provenance".` : undefined },
    { label: "Ocean current at T0", value: a && a.current_status !== "NOT_AVAILABLE" && a.current_speed_ms !== null ? `${fmt(a.current_speed_ms)} m/s toward ${fmt(a.current_direction_to_deg, 0)} deg` : null, status: a?.current_status ?? "NOT_AVAILABLE", note: a?.current_status === "NOT_AVAILABLE" ? "no current product; not observed" : undefined },
    { label: "Drift forcing provenance", value: s.backward ? `wind samples: backtrack ${fractionsText(s.backward.forcing.wind_status_fractions)}; forecast ${fractionsText(s.forward?.forcing.wind_status_fractions)}. Current: ${s.backward.forcing.current_prior_applied ? `no product, zero-mean random prior (sigma ${s.backward.forcing.unknown_current_prior_sigma_ms} m/s) only` : fractionsText(s.backward.forcing.current_status_fractions)}.` : null,
      status: s.backward ? dominantStatus(s.backward.forcing.wind_status_fractions) : null },
    { label: `Backtracked origin (T-${s.backward?.hours ?? "?"} h)`, value: s.backward ? `${fmtLatLon(s.backward.final.centroid, 4)}, P90 radius ${fmt(s.backward.final.r90_km)} km` : null },
    { label: `Forecast ${selSnap ? `T+${selSnap.hours} h` : ""}`.trim(), value: selSnap ? `${fmtLatLon(selSnap.centroid, 4)}, P90 envelope ${fmt(selSnap.hull_area_km2, 0)} km2` : null },
    { label: "Top-ranked candidate (lead only)", value: top ? `#1 ${top.vessel_name} (MMSI ${top.mmsi}), score ${fmt(top.composite_score, 3)}, gap to #2 ${fmt(att?.score_gap_top2 ?? null, 3)}` : null },
    { label: "Overall uncertainty", value: s.uncertainty ? s.uncertainty.components.map((c) => `${c.component}: ${c.level}`).join("; ") : null, chip: s.uncertainty ? { dim: "uncertainty", level: s.uncertainty.overall } : undefined },
    { label: "Risk level", value: s.risk ? s.risk.rationale : null, chip: s.risk ? { dim: "risk", level: s.risk.level } : undefined },
    { label: "SAR look-alike risk", value: env ? (env.low_wind_lookalike_risk ? `ELEVATED: wind ${fmt(a?.wind_speed_ms)} m/s < ~3 m/s` : "no low-wind flag") : null },
  ];

  // ------------------------------------------------------------ data sources
  const ws: any = env?.sources?.wind ?? null;
  const cs: any = env?.sources?.current ?? null;
  const dataSources: Row[] = [
    { label: "SAR scene", value: scene ? `${scene.satellite}, ${scene.polarization}, acquired ${utc(scene.acquisition_time)}; ${scene.data_source ?? ""}` : null, status: scene ? (synthetic ? "SYNTHETIC_DEMO" : "REAL") : null },
    { label: "Slick outline", value: det ? `${det.geometry_source}: ${det.geometry_source_detail ?? ""}` : null, status: det?.geometry_source ?? null },
    { label: "Segmentation model", value: det?.ml_model ? `${det.ml_model.name} ${det.ml_model.checkpoint ?? ""} (epoch ${det.ml_model.checkpoint_epoch ?? "?"}, validation Dice ${fmt(det.ml_model.best_validation_dice ?? null, 3)})` : synthetic ? "Not used (synthetic scene)" : null },
    { label: "Wind", value: ws ? [ws.label, ws.source, ws.source_file, ws.time_range ? `native times ${ws.time_range.join(" .. ")} (${ws.n_times} fields)` : null, ws.grid_shape ? `grid ${ws.grid_shape.join("x")} (t x lat x lon)` : null].filter(Boolean).join("; ") : null, status: ws?.status ?? "NOT_AVAILABLE" },
    { label: "Ocean current", value: cs ? cs.label : null, status: cs?.status ?? "NOT_AVAILABLE" },
    { label: "AIS", value: s.ais ? `${s.ais.source}; ${s.ais.file}; ${s.ais.records} reports, ${s.ais.vessels} vessels${s.ais.spatial_extent ? `; clipped to ${JSON.stringify(s.ais.spatial_extent)}` : ""}` : null, status: s.ais ? (s.ais.synthetic ? "SYNTHETIC_DEMO" : "REAL") : null },
    { label: "2018 offline attribution baseline", value: candidates.some((c) => c.baseline_offline_score != null) ? "data/ais/2018/trajectory_attribution_2018-09-26.csv (reproduced by the engine; shown for comparison)" : "not applicable to this scene", status: candidates.some((c) => c.baseline_offline_score != null) ? "REAL_DERIVED" : null },
    { label: "Drift engine", value: s.backward ? `AEGIS Lagrangian engine (server/lib/drift.ts): ${s.backward.forcing.integration}` : null },
    { label: "Investigation runtime", value: view.graph?.runtime ?? null },
    { label: "Orchestrator", value: view.graph?.orchestrator_info
        ? `ORCHESTRATOR = ${view.graph.orchestrator_status}${view.graph.orchestrator_info.status === "LANGGRAPH" ? `; ${view.graph.orchestrator_info.package} ${view.graph.orchestrator_info.package_version} executed ${view.graph.orchestrator_info.graph_node_invocations} nodes` : `; ${view.graph.orchestrator_info.note ?? "deterministic orchestrator"}`}. Nodes are rule-based computations; no language model produced any value in this report.`
        : (view.graph?.runtime ?? null) },
    { label: "NOT ASSESSED", value: "Wave height, sea-surface temperature, coastal / port / protected-area exposure, SAR look-alike classification (only a low-wind flag exists), oil weathering and beaching." },
  ];
  for (const d of input.dataInventory ?? []) dataSources.push({ label: "Data file", value: `${d.file} - ${d.role} (${d.present ? "present" : "MISSING"})`, status: d.present ? null : "NOT_AVAILABLE" });

  // ------------------------------------------------------------ limitations & warnings
  const reg = input.registry?.models?.find((m: any) => m.role === "production-baseline");
  const limitations = dedupe([
    ...(synthetic ? ["SYNTHETIC DEMO SCENE: slick, environment and AIS are generated; nothing in this report describes a real event."] : []),
    ...(environment && !environment.currentAvailable
      ? [`No ocean-current product: currents enter the drift engine only as a zero-mean random prior${environment.currentPriorSigma != null ? ` (sigma = ${environment.currentPriorSigma} m/s)` : ""} that widens envelopes. It is uncertainty, not an observation.`]
      : []),
    ...(s.backward?.model_limitations ?? []),
    ...(s.forward?.model_limitations ?? []),
    ...(reg?.known_limitations ?? []),
    ...(det?.segmentation_quality?.note ? [`Segmentation: ${det.segmentation_quality.note}`] : []),
    "Single SAR observation: slick age and evolution are not observed.",
    "Transport only: no evaporation, emulsification, dispersion or beaching is modelled.",
    "Coastline, port, protected-area and shipping-lane layers are not bundled: exposure of the impact zone is not assessed.",
    "No SAR look-alike classifier is implemented; low wind is flagged but not filtered.",
    "Candidate scores are heuristic compatibility measures, not calibrated probabilities. Vessels not transmitting AIS, or outside the AIS extract, cannot appear.",
  ]);
  const warnings = dedupe([...(s.warnings ?? []), ...((input.images ?? []).filter((i) => !i.bytes).map((i) => `Image "${i.name}" unavailable: ${i.error ?? "not loaded"}`))]);

  const failed = view.events.find((e) => e.status === "failed");
  if (failed) warnings.unshift(`Node ${failed.label} FAILED: ${failed.error ?? "unknown error"}`);

  return {
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    incidentId,
    investigationId: view.investigation_id,
    investigationStatus: view.status,
    runtime: view.graph?.runtime ?? "",
    synthetic,
    scene,
    horizon,
    selectedVessel,
    summary,
    detection: det,
    characterization: s.characterization ?? null,
    vertices: (det?.geometry.coordinates ?? []) as [number, number][],
    environment,
    backward: s.backward ?? null,
    forward: s.forward ?? null,
    forecastRows,
    ais: s.ais ?? null,
    attribution: att,
    attributionUncertainty: attUnc,
    dossiers,
    hypotheses: s.hypotheses ?? [],
    uncertainty: s.uncertainty ?? null,
    risk: s.risk ?? null,
    recommendations: s.recommendations ?? [],
    timeline: view.events ?? [],
    dataSources,
    limitations,
    warnings,
    missing,
    disclaimers: dedupe([LEGAL_DISCLAIMER, s.report?.disclaimer ?? "", det?.disclaimer ?? "", candidates[0]?.scientific_disclaimer ?? ""]),
    images: input.images ?? [],
    counterfactuals: (input.counterfactuals ?? []).filter((c) => c && c.investigation_id === view.investigation_id),
  };
}

export { fmtLat, fmtLon, fractionsText, pct };
