/**
 * AEGIS investigation graph.
 *
 * A deterministic state graph: each node is a function over a shared state
 * object that calls the scientific engines (detection record, environment,
 * drift, AIS scoring). Nodes never invent numbers; every value they emit is
 * computed from engine outputs. Node status events are emitted as the nodes
 * actually execute (no simulated progress).
 *
 * This is NOT LangGraph. The node contract (state in -> partial state out,
 * conditional router per node) is deliberately the same shape as a LangGraph
 * StateGraph so the orchestration can be moved onto @langchain/langgraph
 * without touching the scientific code.
 */

import { SceneService, DetectionRecord, SceneRecord, REAL_SCENE_ID } from "./scenes";
import { runDrift, DriftResult, DEFAULT_DRIFT_PARAMS } from "./drift";
import { scoreCandidates, AttributionResult, Weights, normalizeWeights, DEFAULT_WEIGHTS } from "./attribution";
import { sampleField, gridVectors, nativeTimeSeries, describeSource } from "./environment";
import { vectorBearingTo, windDirectionFrom, axialDifference, round, formatLat, formatLon } from "./geo";
import { VesselTrack } from "./ais";
import { reviewPriority } from "./review";
import fs from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

export type NodeStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface NodeEvent {
  seq: number;
  investigation_id: string;
  node: string;
  label: string;
  status: NodeStatus;
  at: string;
  duration_ms?: number;
  summary?: string;
  evidence?: string[];
  warnings?: string[];
  data_sources?: string[];
  confidence?: { level: "HIGH" | "MEDIUM" | "LOW" | "N/A"; basis: string };
  error?: string;
}

export interface InvestigationParams {
  scene_id: string;
  backtrack_hours: number;
  forecast_hours: number[];
  num_particles: number;
  timestep_minutes: number;
  wind_factor: number;
  eddy_diffusivity: number;
  unknown_current_sigma: number;
  seed: number;
  weights: Weights;
}

export interface EvidenceItem {
  text: string;
  strength: 1 | 2 | 3;
  source: string;
}

export interface Hypothesis {
  id: "H1" | "H2" | "H3" | "H4";
  title: string;
  statement: string;
  supporting: EvidenceItem[];
  contradicting: EvidenceItem[];
  missing_evidence: string[];
  evidence_balance: number | null;
  evidence_strength: "STRONG" | "MODERATE" | "WEAK" | "NONE";
  uncertainty: "HIGH" | "MEDIUM" | "LOW";
}

export interface InvestigationState {
  params: InvestigationParams;
  scene?: SceneRecord;
  detection?: DetectionRecord;
  characterization?: Record<string, any>;
  environment?: Record<string, any>;
  backward?: DriftResult;
  forward?: DriftResult;
  ais?: Record<string, any>;
  attribution?: AttributionResult;
  evidence_graph?: { nodes: any[]; edges: any[] };
  hypotheses?: Hypothesis[];
  uncertainty?: Record<string, any>;
  risk?: Record<string, any>;
  recommendations?: { priority: "IMMEDIATE" | "HIGH" | "ROUTINE"; action: string; rationale: string }[];
  report?: Record<string, any>;
  warnings: string[];
}

export interface Investigation {
  id: string;
  created_at: string;
  updated_at: string;
  status: "running" | "completed" | "failed";
  state: InvestigationState;
  events: NodeEvent[];
  node_status: Record<string, NodeStatus>;
  listeners: Set<(e: NodeEvent | { type: "complete" }) => void>;
  private: { tracks?: VesselTrack[]; visited?: Set<string> };
  /** Orchestrator that actually executed the last run (never assumed). */
  orchestrator: "deterministic" | "langgraph";
  runtime: string;
  /** What actually ran (never assumed): filled by executeInvestigation. */
  orchestrator_info?: OrchestratorInfo;
}

export interface OrchestratorInfo {
  /** LANGGRAPH only when the real @langchain/langgraph StateGraph executed the nodes; otherwise DETERMINISTIC_FALLBACK. */
  status: "LANGGRAPH" | "DETERMINISTIC_FALLBACK";
  requested: string;
  package: string | null;
  package_version: string | null;
  core_version: string | null;
  /** number of AEGIS nodes that were invoked BY the LangGraph runtime in the last run (0 for the fallback) */
  graph_node_invocations: number;
  /** nodes are rule-based computation steps; no language model is used anywhere in the investigation */
  llm_used: false;
  node_kind: "RULE_BASED_COMPUTATION";
  note: string | null;
}

function installedVersion(pkg: string): string | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.cwd(), "node_modules", pkg, "package.json"), "utf8")).version ?? null;
  } catch {
    return null;
  }
}

interface NodeResult {
  patch: Partial<InvestigationState>;
  summary: string;
  evidence?: string[];
  warnings?: string[];
  data_sources?: string[];
  confidence?: NodeEvent["confidence"];
}

interface NodeDef {
  id: string;
  label: string;
  description: string;
  requires: (keyof InvestigationState)[];
  run: (inv: Investigation, svc: SceneService) => NodeResult;
  route?: (state: InvestigationState) => string | null;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const S = (x: number | null | undefined, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? "n/a" : x.toFixed(d));

function balance(sup: EvidenceItem[], con: EvidenceItem[]): number | null {
  const s = sup.reduce((a, e) => a + e.strength, 0);
  const c = con.reduce((a, e) => a + e.strength, 0);
  return s + c === 0 ? null : round(s / (s + c), 3);
}

function strengthLabel(sup: EvidenceItem[], con: EvidenceItem[] = []): Hypothesis["evidence_strength"] {
  const s = sup.reduce((a, e) => a + e.strength, 0);
  const c = con.reduce((a, e) => a + e.strength, 0);
  if (s === 0) return "NONE";
  // Contradicting evidence caps the label: strong support that is heavily contradicted is only MODERATE.
  if (s >= 7) return c >= 0.5 * s ? "MODERATE" : "STRONG";
  if (s >= 4) return "MODERATE";
  return "WEAK";
}

function levelFromMissing(n: number, extra = 0): Hypothesis["uncertainty"] {
  const k = n + extra;
  return k >= 3 ? "HIGH" : k >= 1 ? "MEDIUM" : "LOW";
}

// ---------------------------------------------------------------------------
// nodes
// ---------------------------------------------------------------------------

export const NODES: NodeDef[] = [
  {
    id: "satellite_detection",
    label: "Scene & SAR Detection Agent",
    description: "Load the SAR scene and its slick segmentation record with provenance.",
    requires: [],
    run: (inv, svc) => {
      const scene = svc.getScene(inv.state.params.scene_id);
      if (!scene) throw new Error(`Scene not found: ${inv.state.params.scene_id}`);
      const detection = svc.detect(scene.scene_id);
      const w: string[] = [];
      if (detection.geometry_source === "NOT_AVAILABLE")
        w.push("MODEL_PREDICTION_UNAVAILABLE: no U-Net prediction for this scene. The labelled reference mask is evaluation-only and is not used as a detection.");
      if (detection.reference_label)
        w.push("A REFERENCE_LABEL mask exists for this scene; it is shown as an evaluation overlay only and never feeds drift, attribution or hypotheses.");
      if (detection.synthetic) w.push("SYNTHETIC demo scene: no real SAR data.");
      return {
        patch: { scene, detection },
        summary: `${scene.satellite} ${scene.polarization} at ${scene.acquisition_time}; slick ${detection.geometry.has_detection ? "present" : "absent"} (${detection.geometry_source}).`,
        evidence: [
          `Centroid ${formatLat(detection.geometry.centroid[0])}, ${formatLon(detection.geometry.centroid[1])}.`,
          `Geometry source: ${detection.geometry_source_detail}`,
        ],
        warnings: w,
        data_sources: [detection.data_source],
        confidence: detection.synthetic
          ? { level: "N/A", basis: "synthetic scene" }
          : detection.geometry_source === "NOT_AVAILABLE"
            ? { level: "N/A", basis: "no model prediction" }
            : {
                level: "MEDIUM",
                basis:
                  `U-Net held-out test-set mean Dice ${S(detection.segmentation_quality?.test_set_mean_dice as number | null, 3)} (${detection.segmentation_quality?.fresh_test_set_provenance ?? "n/a"}); ` +
                  `this scene ${S(detection.segmentation_quality?.scene_dice_vs_label as number | null, 3)} against its reference label (${detection.segmentation_quality?.scene_metrics_provenance ?? "n/a"})`,
              },
      };
    },
    route: (s) => (s.detection?.geometry.has_detection ? null : "report_generation"),
  },
  {
    id: "spill_characterization",
    label: "Spill Geometry Agent",
    description: "Geodesic area, perimeter, principal axis and elongation of the slick.",
    requires: ["detection"],
    run: (inv) => {
      const g = inv.state.detection!.geometry;
      const axisGap = axialDifference(g.orientation_deg, g.polygon_principal_axis_deg);
      const w: string[] = [];
      if (axisGap > 10)
        w.push(`Recorded mask axis (${S(g.orientation_deg, 1)}°) and polygon principal axis (${S(g.polygon_principal_axis_deg, 1)}°) differ by ${S(axisGap, 1)}°: the outline is a coarse approximation.`);
      const characterization = {
        area_km2: g.area_km2,
        perimeter_km: g.perimeter_km,
        axis_deg: g.orientation_deg,
        axis_source: g.orientation_source,
        polygon_axis_deg: g.polygon_principal_axis_deg,
        elongation: g.elongation,
        compactness: round((4 * Math.PI * g.area_km2) / (g.perimeter_km * g.perimeter_km), 3),
        pixel_count: g.pixel_count,
        area_basis: `${inv.state.detection!.geometry.area_basis} (DERIVED_GEOMETRY from ${inv.state.detection!.geometry_source})`,
      };
      return {
        patch: { characterization },
        summary: `Area ${S(g.area_km2)} km², perimeter ${S(g.perimeter_km, 1)} km, axis ${S(g.orientation_deg, 1)}°, elongation ${S(g.elongation)}.`,
        evidence: [`Compactness ${characterization.compactness} (1 = circle).`, `Area basis: ${characterization.area_basis}.`],
        warnings: w,
        data_sources: ["Geodesic computation on WGS84 polygon (local tangent-plane shoelace)"],
        confidence: { level: "MEDIUM", basis: characterization.area_basis },
      };
    },
  },
  {
    id: "environmental_analysis",
    label: "Environmental Forcing Agent",
    description: "Sample wind/current at the slick, check product coverage over the analysis windows, flag look-alike conditions.",
    requires: ["detection"],
    run: (inv, svc) => {
      const d = inv.state.detection!;
      const p = inv.state.params;
      const env = svc.environment(d.scene_id);
      const [lat, lon] = d.geometry.centroid;
      const t0 = Date.parse(d.detection_time);
      const w = sampleField(env.wind, lat, lon, t0);
      const c = sampleField(env.current, lat, lon, t0);
      const windSpeed = Math.hypot(w.u, w.v);
      const windTo = vectorBearingTo(w.u, w.v);
      const axisDiff = axialDifference(windTo, d.geometry.orientation_deg);
      const desc = svc.environmentDescription(d.scene_id);
      const warnings: string[] = [];
      let coverage: Record<string, number | null> = { backward_window_fraction: null, forward_window_fraction: null };
      if (env.wind.kind === "gridded") {
        const tt = env.wind.timesMs;
        const lo = Math.min(...tt), hi = Math.max(...tt);
        const frac = (a: number, b: number) => Math.max(0, Math.min(b, hi) - Math.max(a, lo)) / (b - a);
        coverage = {
          backward_window_fraction: round(frac(t0 - p.backtrack_hours * 3600e3, t0), 4),
          forward_window_fraction: round(frac(t0, t0 + Math.max(...p.forecast_hours) * 3600e3), 4),
        };
        if ((coverage.backward_window_fraction ?? 0) < 0.5 || (coverage.forward_window_fraction ?? 0) < 0.5)
          warnings.push(`ERA5 covers only ${S((coverage.backward_window_fraction ?? 0) * 100, 0)} % of the backtrack window and ${S((coverage.forward_window_fraction ?? 0) * 100, 0)} % of the forecast window; outside it the nearest hourly field is persisted.`);
      }
      if (env.current.kind === "none") warnings.push("No ocean-current product: currents are not observed for this scene.");
      const lowWind = w.status !== "NOT_AVAILABLE" && windSpeed < 3;
      if (lowWind) warnings.push(`Wind ${S(windSpeed)} m/s is below ~3 m/s: SAR dark areas at low wind are frequently look-alikes (calm water, biogenic films).`);
      const environment = {
        at_observation: {
          time: d.detection_time,
          wind_u10_ms: round(w.u, 3),
          wind_v10_ms: round(w.v, 3),
          wind_speed_ms: round(windSpeed, 3),
          wind_speed_knots: round(windSpeed * 1.943844, 2),
          wind_direction_to_deg: round(windTo, 1),
          wind_direction_from_deg: round(windDirectionFrom(w.u, w.v), 1),
          wind_status: w.status,
          current_uo_ms: c.status === "NOT_AVAILABLE" ? null : round(c.u, 3),
          current_vo_ms: c.status === "NOT_AVAILABLE" ? null : round(c.v, 3),
          current_speed_ms: c.status === "NOT_AVAILABLE" ? null : round(Math.hypot(c.u, c.v), 3),
          current_direction_to_deg: c.status === "NOT_AVAILABLE" ? null : round(vectorBearingTo(c.u, c.v), 1),
          current_status: c.status,
        },
        wind_slick_axis_difference_deg: round(axisDiff, 1),
        wind_slick_consistency: round(Math.max(0, 1 - axisDiff / 90), 3),
        low_wind_lookalike_risk: lowWind,
        coverage,
        wind_grid_at_observation: gridVectors(env.wind, t0),
        current_grid_at_observation: gridVectors(env.current, t0),
        wind_time_series: nativeTimeSeries(env.wind, lat, lon),
        current_time_series: nativeTimeSeries(env.current, lat, lon),
        sources: desc,
      };
      return {
        patch: { environment },
        summary: `Wind ${S(windSpeed)} m/s from ${S(environment.at_observation.wind_direction_from_deg, 0)}° (${w.status}); current ${c.status === "NOT_AVAILABLE" ? "not available" : S(Math.hypot(c.u, c.v)) + " m/s (" + c.status + ")"}.`,
        evidence: [
          `Wind axis vs slick axis: ${S(axisDiff, 1)}° (axial).`,
          `Wind product: ${desc.wind.label} [${desc.wind.status}].`,
          `Current product: ${desc.current.label} [${desc.current.status}].`,
        ],
        warnings,
        data_sources: [desc.wind.label, desc.current.label],
        confidence: {
          level: env.wind.kind === "gridded" && env.current.kind !== "none" ? "HIGH" : env.wind.kind === "gridded" ? "MEDIUM" : "LOW",
          basis: env.current.kind === "none" ? "wind observed at T0; currents missing" : "wind and current products available",
        },
      };
    },
  },
  {
    id: "backward_origin",
    label: "Backtracking Agent",
    description: "Backward Lagrangian particle tracking from the observed slick to an origin corridor.",
    requires: ["detection"],
    run: (inv, svc) => {
      const d = inv.state.detection!;
      const p = inv.state.params;
      const snaps = [1, 2, 3, 4, 6, 9, 12, 18, 24, 36, 48].filter((h) => h < p.backtrack_hours);
      const backward = runDrift(
        { startTimeIso: d.detection_time, seedRing: d.geometry.coordinates, seedRings: d.geometry.parts, seedPoint: d.geometry.centroid, env: svc.environment(d.scene_id) },
        {
          mode: "BACKWARD",
          hours: p.backtrack_hours,
          timestepMinutes: p.timestep_minutes,
          numParticles: p.num_particles,
          windFactor: p.wind_factor,
          eddyDiffusivity: p.eddy_diffusivity,
          unknownCurrentSigma: p.unknown_current_sigma,
          seed: p.seed,
          snapshotHours: [...snaps, p.backtrack_hours],
        },
      );
      const f = backward.final;
      return {
        patch: { backward },
        summary: `Origin hypothesis at T-${S(backward.hours, 1)} h: ${formatLat(f.centroid[0])}, ${formatLon(f.centroid[1])}; P90 radius ${S(f.r90_km)} km; drift ${S(f.displacement_km)} km toward ${S(f.displacement_bearing_deg, 0)}° reversed.`,
        evidence: [
          `${backward.num_particles} particles, ${backward.forcing.integration}.`,
          `Wind sample status: ${JSON.stringify(backward.forcing.wind_status_fractions)}.`,
        ],
        warnings: backward.warnings,
        data_sources: ["AEGIS Lagrangian engine (server/lib/drift.ts)"],
        confidence: {
          level: (backward.forcing.wind_status_fractions["REAL"] ?? 0) > 0.5 && !backward.forcing.current_prior_applied ? "MEDIUM" : "LOW",
          basis: "limited by forcing coverage; origin is an ensemble region, not a point",
        },
      };
    },
  },
  {
    id: "forward_forecast",
    label: "Forward Drift Forecast Agent",
    description: "Forward Lagrangian forecast from the observed slick at T+6/12/24/48 h (Future Impact Zone).",
    requires: ["detection"],
    run: (inv, svc) => {
      const d = inv.state.detection!;
      const p = inv.state.params;
      const horizon = Math.max(...p.forecast_hours);
      const forward = runDrift(
        { startTimeIso: d.detection_time, seedRing: d.geometry.coordinates, seedRings: d.geometry.parts, seedPoint: d.geometry.centroid, env: svc.environment(d.scene_id) },
        {
          mode: "FORWARD",
          hours: horizon,
          timestepMinutes: p.timestep_minutes,
          numParticles: p.num_particles,
          windFactor: p.wind_factor,
          eddyDiffusivity: p.eddy_diffusivity,
          unknownCurrentSigma: p.unknown_current_sigma,
          seed: p.seed + 1,
          snapshotHours: p.forecast_hours,
        },
      );
      return {
        patch: { forward },
        summary: forward.snapshots
          .map((s) => `T+${s.hours}h: P90 ${S(s.r90_km, 1)} km, envelope ${S(s.hull_area_km2, 0)} km²${s.forcing_support.supported === false ? " [NOT SUPPORTED BY FORCING]" : ""}`)
          .join("; "),
        evidence: forward.snapshots.map(
          (s) =>
            `T+${s.hours} h centroid ${formatLat(s.centroid[0])}, ${formatLon(s.centroid[1])}, displaced ${S(s.displacement_km)} km toward ${S(s.displacement_bearing_deg, 0)}° ` +
            `(wind ${S(s.forcing_support.wind_real_fraction * 100, 0)} % REAL, current ${S(s.forcing_support.current_real_fraction * 100, 0)} % REAL${s.forcing_support.supported === false ? "; NOT SUPPORTED BY FORCING - persistence scenario, not a forecast" : ""}).`,
        ),
        warnings: [
          ...forward.warnings,
          ...(forward.snapshots.some((s) => s.forcing_support.supported === false)
            ? [`Forecast horizons ${forward.snapshots.filter((s) => s.forcing_support.supported === false).map((s) => "T+" + s.hours + "h").join(", ")} are NOT supported by real forcing coverage; they are labelled persistence scenarios, not forecasts.`]
            : []),
          "Forward drift is a hindcast/scenario from reanalysis-type forcing, not an observation. Coastline, port and sensitive-area layers are not bundled: exposure of the impact zone is NOT assessed.",
        ],
        data_sources: ["AEGIS Lagrangian engine (server/lib/drift.ts)"],
        confidence: {
          level: forward.snapshots.every((s) => s.forcing_support.supported === true) ? "MEDIUM" : "LOW",
          basis: forward.snapshots.some((s) => s.forcing_support.supported === false)
            ? "forcing coverage does not support the horizons (wind persisted beyond the ERA5 window and/or no current product)"
            : "wind and current products cover the forecast window",
        },
      };
    },
  },
  {
    id: "ais_investigation",
    label: "AIS Candidate Retrieval Agent",
    description: "Load AIS, reconstruct vessel tracks, check spatial coverage.",
    requires: ["detection"],
    run: (inv, svc) => {
      const d = inv.state.detection!;
      const a = svc.ais(d.scene_id);
      inv.private.tracks = a.tracks;
      const t0 = Date.parse(d.detection_time);
      const H = inv.state.params.backtrack_hours;
      const active = a.tracks.filter((t) => t.points.some((q) => q.t >= t0 - H * 3600e3 && q.t <= t0 + 0.5 * 3600e3)).length;
      const ais = {
        source: a.label,
        file: a.file,
        records: a.records,
        vessels: a.tracks.length,
        vessels_active_in_window: active,
        spatial_extent: a.bbox,
        synthetic: a.synthetic,
      };
      const warnings: string[] = [];
      if (a.bbox) warnings.push(`AIS extract is clipped to the scene box ${JSON.stringify(a.bbox)}; tracks outside it are not available.`);
      if (a.synthetic) warnings.push("SYNTHETIC AIS tracks (demo).");
      if (!a.tracks.length) warnings.push("No AIS tracks available.");
      return {
        patch: { ais },
        summary: `${a.records} AIS reports, ${a.tracks.length} vessels (${active} active in [T0-${H} h, T0+0.5 h]).`,
        evidence: [`Source file: ${a.file}.`],
        warnings,
        data_sources: [a.label],
        confidence: { level: a.synthetic ? "N/A" : a.bbox ? "MEDIUM" : "HIGH", basis: a.bbox ? "spatially clipped extract" : "full extract" },
      };
    },
    route: (s) => ((s.ais?.vessels ?? 0) > 0 ? null : "uncertainty"),
  },
  {
    id: "evidence_fusion",
    label: "Vessel Attribution & Evidence Agent",
    description: "Score every vessel on four exposed factors, rank, and build the evidence graph.",
    requires: ["detection", "backward", "ais"],
    run: (inv, svc) => {
      const d = inv.state.detection!;
      const a = svc.ais(d.scene_id);
      const attribution = scoreCandidates(
        inv.private.tracks ?? a.tracks,
        {
          obsTimeMs: Date.parse(d.detection_time),
          slickRing: d.geometry.coordinates,
          slickRings: d.geometry.parts,
          slickCentroid: d.geometry.centroid,
          slickAxisDeg: d.geometry.orientation_deg,
          corridor: inv.state.backward!.centroid_path,
          horizonHours: inv.state.params.backtrack_hours,
          aisBbox: a.bbox,
          baseline: svc.baseline(d.scene_id),
          dataSourceLabel: a.label,
        },
        inv.state.params.weights,
      );
      const evidence_graph = buildEvidenceGraph(inv.state, attribution);
      const top = attribution.candidates[0];
      return {
        patch: { attribution, evidence_graph },
        summary: top
          ? `Top priority candidate: ${top.vessel_name} (MMSI ${top.mmsi}) score ${S(top.composite_score, 3)}; gap to #2 ${S(attribution.score_gap_top2, 3)}. ${attribution.high_priority_count} high / ${attribution.medium_priority_count} medium.`
          : "No candidate vessels.",
        evidence: top ? top.why_priority : [],
        warnings: attribution.coverage_warnings,
        data_sources: [a.label, "Backtracked drift corridor"],
        confidence: {
          level: !top ? "N/A" : (attribution.score_gap_top2 ?? 0) >= 0.1 && top.sensitivity.stable ? "MEDIUM" : "LOW",
          basis: "ranking separation and stability under leave-one-factor-out",
        },
      };
    },
  },
  {
    id: "uncertainty",
    label: "Uncertainty & Quality-Control Agent",
    description: "Separate uncertainty from confidence for segmentation, area, origin, forecast and attribution.",
    requires: ["detection"],
    run: (inv, svc) => {
      const uncertainty = buildUncertainty(inv.state, svc);
      return {
        patch: { uncertainty },
        summary: `Overall uncertainty ${uncertainty.overall}. ` + uncertainty.components.map((c: any) => `${c.component}: ${c.level}`).join(", "),
        evidence: uncertainty.components.map((c: any) => `${c.component}: ${c.basis}`),
        data_sources: ["Model registry", "Drift ensembles", "Attribution sensitivity"],
        confidence: { level: "N/A", basis: "uncertainty assessment" },
      };
    },
  },
  {
    id: "competing_hypotheses",
    label: "Competing-Hypotheses Agent",
    description: "Weigh H1 (vessel compatible), H2 (natural look-alike), H3 (another vessel), H4 (data insufficient).",
    requires: ["detection", "environment"],
    run: (inv) => {
      const hypotheses = buildHypotheses(inv.state);
      return {
        patch: { hypotheses },
        summary: hypotheses.map((h) => `${h.id}: ${h.evidence_strength} support (balance ${h.evidence_balance ?? "n/a"})`).join(" | "),
        evidence: hypotheses.map((h) => `${h.id} ${h.title}: ${h.supporting.length} supporting, ${h.contradicting.length} contradicting, ${h.missing_evidence.length} missing.`),
        warnings: ["Evidence balance is a transparent heuristic (supporting vs contradicting strength), not a probability."],
        data_sources: ["Outputs of all previous nodes"],
        confidence: { level: "N/A", basis: "heuristic evidence weighing" },
      };
    },
  },
  {
    id: "risk_assessment",
    label: "Risk Assessment Agent",
    description: "Observed extent, forecast spread, and exposure status.",
    requires: ["detection"],
    run: (inv) => {
      const risk = buildRisk(inv.state);
      return {
        patch: { risk },
        summary: `Risk ${risk.level}: ${risk.rationale}`,
        evidence: risk.factors.map((f: any) => `${f.name}: ${f.value} (${f.category})`),
        warnings: risk.exposure_assessed ? [] : ["Exposure (coast, ports, sensitive habitats) not assessed: no reference layers bundled."],
        data_sources: ["Spill geometry", "Forward forecast"],
        confidence: { level: "LOW", basis: "extent-based heuristic; exposure not assessed" },
      };
    },
  },
  {
    id: "response_recommendation",
    label: "Response Recommendation Agent",
    description: "Rule-based verification and response actions derived from the findings.",
    requires: ["detection"],
    run: (inv) => {
      const recommendations = buildRecommendations(inv.state);
      return {
        patch: { recommendations },
        summary: `${recommendations.length} actions (${recommendations.filter((r) => r.priority === "IMMEDIATE").length} immediate).`,
        evidence: recommendations.map((r) => `[${r.priority}] ${r.action}`),
        data_sources: ["Rules in server/lib/investigation.ts"],
        confidence: { level: "N/A", basis: "rule-based" },
      };
    },
  },
  {
    id: "report_generation",
    label: "Final Evidence & Report Agent",
    description: "Assemble the report state consumed by the PDF generator.",
    requires: [],
    run: (inv) => {
      const s = inv.state;
      const report = {
        review: reviewPriority(s),
        incident_id: `AEGIS-${(s.scene?.scene_id ?? "NA").slice(0, 24)}-${inv.id.slice(-6)}`,
        investigation_id: inv.id,
        generated_at: new Date().toISOString(),
        sections_available: {
          detection: !!s.detection,
          environment: !!s.environment,
          backward: !!s.backward,
          forward: !!s.forward,
          attribution: !!s.attribution,
          hypotheses: !!s.hypotheses,
          uncertainty: !!s.uncertainty,
          risk: !!s.risk,
          recommendations: !!s.recommendations,
        },
        disclaimer:
          "AEGIS is a scientific decision-support system. Candidate vessels are investigative leads ranked by spatio-temporal compatibility with a modelled drift history. No output of this system constitutes proof that a vessel discharged oil or legal attribution of responsibility.",
      };
      return { patch: { report }, summary: `Report state assembled (${report.incident_id}).`, data_sources: ["Investigation state"] };
    },
  },
];

// ---------------------------------------------------------------------------
// builders
// ---------------------------------------------------------------------------

function buildEvidenceGraph(s: InvestigationState, att: AttributionResult) {
  const nodes: any[] = [];
  const edges: any[] = [];
  const add = (id: string, type: string, label: string, data: any = {}) => nodes.push({ id, type, label, ...data });
  const link = (from: string, rel: string, to: string, weight?: number) => edges.push({ from, rel, to, weight });
  add("sat", "satellite_observation", `${s.scene?.satellite} ${s.scene?.acquisition_time}`, { status: s.scene?.data_status });
  add("spill", "spill", `Slick ${S(s.detection?.geometry.area_km2)} km²`, { status: s.detection?.geometry_source });
  link("sat", "detects", "spill");
  add("wind", "wind_field", s.environment?.sources?.wind?.label ?? "wind", { status: s.environment?.at_observation?.wind_status });
  add("current", "current_field", s.environment?.sources?.current?.label ?? "current", { status: s.environment?.at_observation?.current_status });
  add("origin", "origin_hypothesis", `Origin corridor T-${s.backward?.hours} h`, { r90_km: s.backward?.final.r90_km });
  link("spill", "backtracks_to", "origin");
  link("wind", "forces", "origin");
  link("current", "forces", "origin");
  for (const sn of s.forward?.snapshots ?? []) {
    add(`fc${sn.hours}`, "forecast", `Impact zone T+${sn.hours} h`, { area_km2: sn.hull_area_km2 });
    link("spill", "forecast_to", `fc${sn.hours}`);
  }
  for (const c of att.candidates.slice(0, 10)) {
    const vid = `v${c.mmsi}`;
    add(vid, "vessel", c.vessel_name, { mmsi: c.mmsi, score: c.composite_score, priority: c.priority_level });
    add(`ais${c.mmsi}`, "ais_evidence", `${c.ais_quality.n_points} AIS reports (${c.ais_quality.quality_label})`);
    link(vid, "supported_by", `ais${c.mmsi}`);
    if (c.metrics.intersects_origin) link("origin", "intersects", vid, c.feature_breakdown.trajectory_intersection_score);
    if (c.metrics.min_distance_to_slick_km === 0) link(vid, "track_crosses", "spill");
  }
  return { nodes, edges };
}

export function buildHypotheses(s: InvestigationState): Hypothesis[] {
  const env = s.environment ?? {};
  const att = s.attribution;
  const top = att?.candidates[0];
  const second = att?.candidates[1];
  const windSpeed: number | null = env.at_observation?.wind_speed_ms ?? null;
  const noCurrent = env.at_observation?.current_status === "NOT_AVAILABLE";
  const windRealBack = s.backward?.forcing.wind_status_fractions?.["REAL"] ?? 0;
  const synthetic = !!s.detection?.synthetic;
  const reg = s.detection?.segmentation_quality as any;

  // H1
  const h1s: EvidenceItem[] = [];
  const h1c: EvidenceItem[] = [];
  if (top) {
    if (top.metrics.intersects_origin) h1s.push({ text: `${top.vessel_name}'s AIS track enters the backtracked P90 corridor.`, strength: 3, source: "evidence_fusion" });
    if (top.metrics.min_distance_to_slick_km === 0) h1s.push({ text: "Track crosses the observed slick outline.", strength: 2, source: "evidence_fusion" });
    else if (top.feature_breakdown.spatial_proximity_score >= 0.8) h1s.push({ text: `Closest approach ${S(top.metrics.min_distance_to_slick_km)} km from slick.`, strength: 2, source: "evidence_fusion" });
    if (top.feature_breakdown.temporal_alignment_score >= 0.99) h1s.push({ text: "Closest approach falls inside the backtrack window.", strength: 2, source: "evidence_fusion" });
    if ((top.metrics.course_slick_axis_difference_deg ?? 99) <= 20) h1s.push({ text: `Course aligned with slick axis (${S(top.metrics.course_slick_axis_difference_deg, 0)}°).`, strength: 1, source: "evidence_fusion" });
    if (top.ais_quality.quality_label === "POOR") h1c.push({ text: `AIS coverage of the window is poor (${Math.round(top.ais_quality.window_coverage_fraction * 100)} %).`, strength: 2, source: "evidence_fusion" });
    if (!top.sensitivity.stable) h1c.push({ text: `Rank unstable when single factors are removed (${top.sensitivity.rank_min}–${top.sensitivity.rank_max}).`, strength: 2, source: "evidence_fusion" });
    if ((att?.score_gap_top2 ?? 1) < 0.05) h1c.push({ text: `Score gap to #2 only ${S(att?.score_gap_top2, 3)}.`, strength: 2, source: "evidence_fusion" });
    if (top.metrics.time_delta_hours > 0.5) h1c.push({ text: "Closest approach occurred after the SAR observation.", strength: 3, source: "evidence_fusion" });
    if ((att?.high_priority_count ?? 0) >= 3) h1c.push({ text: `${att!.high_priority_count} vessels are rated HIGH priority: the available data do not single out one vessel.`, strength: 3, source: "evidence_fusion" });
    if (top.synthetic) h1c.push({ text: "Candidate is synthetic demo data.", strength: 3, source: "ais_investigation" });
  } else {
    h1c.push({ text: "No candidate vessels in the AIS extract.", strength: 3, source: "ais_investigation" });
  }
  if (windSpeed !== null && windSpeed < 3) h1c.push({ text: `Low wind (${S(windSpeed)} m/s) raises look-alike likelihood.`, strength: 1, source: "environmental_analysis" });
  const h1m = ["In-situ oil sample and fingerprinting", "Vessel logs / oil record book", "Unclipped AIS for T0-24 h", ...(noCurrent ? ["Observed surface currents"] : [])];

  // H2
  const h2s: EvidenceItem[] = [];
  const h2c: EvidenceItem[] = [];
  if (windSpeed !== null) {
    if (windSpeed < 2) h2s.push({ text: `Very low wind (${S(windSpeed)} m/s): calm-water and biogenic look-alikes are common.`, strength: 3, source: "environmental_analysis" });
    else if (windSpeed < 3) h2s.push({ text: `Low wind (${S(windSpeed)} m/s) below the ~3 m/s reliability threshold for SAR slick detection.`, strength: 2, source: "environmental_analysis" });
    else if (windSpeed <= 10) h2c.push({ text: `Wind ${S(windSpeed)} m/s is in the range where oil damping is distinguishable from calm water.`, strength: 2, source: "environmental_analysis" });
  }
  if (reg?.test_set_mean_dice !== null && reg?.test_set_mean_dice !== undefined && reg.test_set_mean_dice < 0.6)
    h2s.push({ text: `Segmentation model test-set mean Dice ${S(reg.test_set_mean_dice, 3)}: detections are not reliable across scenes.`, strength: 1, source: "model_registry" });
  // NOTE: the labelled reference mask is evaluation-only and is intentionally NOT used as evidence here.
  if (top && top.metrics.intersects_origin && (top.metrics.course_slick_axis_difference_deg ?? 99) <= 20)
    h2c.push({ text: "A vessel track aligned with the slick axis intersects the origin corridor.", strength: 2, source: "evidence_fusion" });
  const h2m = ["SAR look-alike classifier (not implemented)", "Optical / multispectral imagery", "Second SAR acquisition", "Dual-polarisation (VH) analysis"];

  // H3
  const h3s: EvidenceItem[] = [];
  const h3c: EvidenceItem[] = [];
  if (att && second) {
    const gap = att.score_gap_top2 ?? 0;
    if (gap < 0.05) h3s.push({ text: `#2 ${second.vessel_name} is within ${S(gap, 3)} of #1.`, strength: 3, source: "evidence_fusion" });
    else if (gap < 0.1) h3s.push({ text: `#2 ${second.vessel_name} is within ${S(gap, 3)} of #1.`, strength: 2, source: "evidence_fusion" });
    else if (gap >= 0.15) h3c.push({ text: `Clear gap (${S(gap, 3)}) between #1 and #2.`, strength: 3, source: "evidence_fusion" });
    const inCorridor = att.candidates.filter((c) => c.metrics.intersects_origin).length;
    if (inCorridor > 1) h3s.push({ text: `${inCorridor} vessels enter the origin corridor.`, strength: 2, source: "evidence_fusion" });
    if (top && !top.sensitivity.stable) h3s.push({ text: "Top rank changes under leave-one-factor-out.", strength: 2, source: "evidence_fusion" });
    else if (top) h3c.push({ text: "Top rank stable under leave-one-factor-out.", strength: 2, source: "evidence_fusion" });
  }
  const h3m = ["Unclipped AIS (vessels outside the extract box are invisible)", "Satellite-AIS / dark-vessel detection"];

  // H4
  const h4s: EvidenceItem[] = [];
  const h4c: EvidenceItem[] = [];
  if (windRealBack < 0.5) h4s.push({ text: `Only ${Math.round(windRealBack * 100)} % of backtrack wind samples are inside the ERA5 product coverage.`, strength: 3, source: "backward_origin" });
  else h4c.push({ text: `${Math.round(windRealBack * 100)} % of backtrack wind samples are observed.`, strength: 2, source: "backward_origin" });
  if (noCurrent) h4s.push({ text: "No ocean-current product; origin corridor width is dominated by the current prior.", strength: 3, source: "environmental_analysis" });
  else h4c.push({ text: "Ocean-current product available.", strength: 3, source: "environmental_analysis" });
  if (s.ais?.spatial_extent) h4s.push({ text: "AIS extract is clipped to the scene box.", strength: 2, source: "ais_investigation" });
  h4s.push({ text: "Single SAR observation: slick age and evolution cannot be observed.", strength: 2, source: "satellite_detection" });
  if (s.detection?.geometry_source === "MODEL_PREDICTION") h4s.push({ text: "Slick outline is a model prediction (not a confirmed oil footprint); segmentation quality varies strongly between scenes.", strength: 1, source: "satellite_detection" });
  if (synthetic) h4s.push({ text: "Scene is synthetic.", strength: 3, source: "satellite_detection" });
  const h4m = ["ERA5 hourly wind for T0-48 h to T0+48 h", ...(noCurrent ? ["Historical ocean-current product for the event"] : []), "Full AIS extract"];

  const mk = (id: Hypothesis["id"], title: string, statement: string, sup: EvidenceItem[], con: EvidenceItem[], missing: string[], extraUnc = 0): Hypothesis => ({
    id,
    title,
    statement,
    supporting: sup,
    contradicting: con,
    missing_evidence: missing,
    evidence_balance: balance(sup, con),
    evidence_strength: strengthLabel(sup, con),
    uncertainty: levelFromMissing(missing.length >= 3 ? 2 : 1, extraUnc),
  });
  const u = (noCurrent ? 1 : 0) + (windRealBack < 0.5 ? 1 : 0);
  return [
    mk("H1", "Candidate vessel compatible with origin", top ? `${top.vessel_name} (MMSI ${top.mmsi}) is spatio-temporally compatible with the modelled origin corridor.` : "A listed vessel is compatible with the origin.", h1s, h1c, h1m, u),
    mk("H2", "Natural / environmental look-alike", "The dark SAR feature is a look-alike (low wind, biogenic film, other) rather than mineral oil.", h2s, h2c, h2m, 1),
    mk("H3", "Another vessel is more compatible", second ? `A different vessel (e.g. ${second.vessel_name}) is at least as compatible as the top candidate.` : "Another vessel is more compatible.", h3s, h3c, h3m, s.ais?.spatial_extent ? 1 : 0),
    mk("H4", "Data insufficient", "Available environmental and AIS data are insufficient to discriminate between hypotheses.", h4s, h4c, h4m, 0),
  ];
}

function lvl(x: number, a: number, b: number): "LOW" | "MEDIUM" | "HIGH" {
  return x < a ? "LOW" : x < b ? "MEDIUM" : "HIGH";
}

function buildUncertainty(s: InvestigationState, svc: SceneService) {
  const comps: { component: string; level: "LOW" | "MEDIUM" | "HIGH" | "N/A"; value: any; basis: string }[] = [];
  const reg = svc.modelRegistry()?.models?.find((m: any) => m.role === "production-baseline");
  const per = reg ? Object.values(reg.test_metrics.per_scene).map((x: any) => x.dice as number) : [];
  if (s.detection?.synthetic) comps.push({ component: "Segmentation", level: "N/A", value: null, basis: "synthetic scene" });
  else
    comps.push({
      component: "Segmentation",
      level: "HIGH",
      value: { test_mean_dice: reg?.test_metrics?.mean_dice ?? null, test_dice_min: per.length ? Math.min(...per) : null, test_dice_max: per.length ? Math.max(...per) : null },
      basis: `Test Dice varies from ${S(Math.min(...per), 3)} to ${S(Math.max(...per), 3)} across 7 scenes; probabilities uncalibrated; no MC-dropout/ensemble.`,
    });
  comps.push({
    component: "Spill area",
    level: s.detection?.synthetic ? "N/A" : "MEDIUM",
    value: s.detection?.geometry.area_km2,
    basis: s.detection?.segmentation_quality?.scene_dice_vs_label != null
      ? `Predicted-pixel area; measured on this scene against its reference label: precision ${S(s.detection.segmentation_quality.scene_precision_vs_label as number, 3)}, recall ${S(s.detection.segmentation_quality.scene_recall_vs_label as number, 3)} (over-/under-estimation possible).`
      : "Area of the predicted mask; not measured against a label.",
  });
  if (s.backward)
    comps.push({
      component: "Origin location",
      level: lvl(s.backward.final.r90_km, 2, 5),
      value: { r90_km: s.backward.final.r90_km, envelope_km2: s.backward.final.hull_area_km2 },
      basis: `P90 radius ${S(s.backward.final.r90_km)} km at T-${s.backward.hours} h${s.backward.forcing.current_prior_applied ? " (current prior dominates)" : ""}.`,
    });
  if (s.forward) {
    const last = s.forward.snapshots[s.forward.snapshots.length - 1];
    comps.push({ component: "Drift forecast", level: lvl(last?.r90_km ?? 0, 5, 15), value: s.forward.snapshots.map((x) => ({ h: x.hours, r90_km: x.r90_km })), basis: `P90 radius ${S(last?.r90_km)} km at T+${last?.hours} h.` });
  }
  if (s.attribution?.candidates.length) {
    const top = s.attribution.candidates[0];
    const gap = s.attribution.score_gap_top2 ?? 1;
    comps.push({
      component: "Vessel attribution",
      level: gap < 0.05 || !top.sensitivity.stable ? "HIGH" : gap < 0.15 ? "MEDIUM" : "LOW",
      value: { score_gap_top2: gap, rank_range_top: [top.sensitivity.rank_min, top.sensitivity.rank_max] },
      basis: `Top score ${S(top.composite_score, 3)} with gap ${S(gap, 3)} to #2; rank range ${top.sensitivity.rank_min}–${top.sensitivity.rank_max} under factor removal.`,
    });
  }
  const order = { LOW: 0, MEDIUM: 1, HIGH: 2, "N/A": -1 } as const;
  const overall = comps.reduce((m, c) => (order[c.level] > order[m] ? (c.level as "LOW" | "MEDIUM" | "HIGH") : m), "LOW" as "LOW" | "MEDIUM" | "HIGH");
  return {
    overall,
    components: comps,
    note: "Uncertainty is reported separately from scores: a high attribution score with HIGH uncertainty is not a confident result.",
  };
}

function buildRisk(s: InvestigationState) {
  const area = s.detection?.geometry.area_km2 ?? 0;
  const extentCat = area < 1 ? "SMALL" : area < 10 ? "MODERATE" : area < 100 ? "LARGE" : "VERY LARGE";
  const f24 = s.forward?.snapshots.find((x) => x.hours === 24) ?? s.forward?.snapshots[s.forward.snapshots.length - 1];
  const spreadCat = !f24 ? "UNKNOWN" : f24.hull_area_km2 < 50 ? "CONTAINED" : f24.hull_area_km2 < 500 ? "SPREADING" : "WIDE";
  const lookalike = !!s.environment?.low_wind_lookalike_risk;
  let level: "LOW" | "MODERATE" | "HIGH" | "SEVERE" = extentCat === "SMALL" ? "LOW" : extentCat === "MODERATE" ? "MODERATE" : extentCat === "LARGE" ? "HIGH" : "SEVERE";
  const rationale = [`observed extent ${S(area, 1)} km² (${extentCat})`, `T+24 h envelope ${S(f24?.hull_area_km2, 0)} km² (${spreadCat})`];
  if (lookalike) rationale.push("look-alike risk (low wind) — verify before escalation");
  if (s.detection?.synthetic) {
    level = "LOW";
    rationale.push("synthetic scene");
  }
  return {
    level,
    color: level === "SEVERE" ? "#b91c1c" : level === "HIGH" ? "#ea580c" : level === "MODERATE" ? "#ca8a04" : "#16a34a",
    rationale: rationale.join("; "),
    factors: [
      { name: "Observed extent", value: `${S(area, 1)} km²`, category: extentCat },
      { name: "Forecast spread (T+24 h envelope)", value: `${S(f24?.hull_area_km2, 0)} km²`, category: spreadCat },
      { name: "Look-alike risk", value: lookalike ? "low wind" : "no low-wind flag", category: lookalike ? "ELEVATED" : "NORMAL" },
      { name: "Exposure (coast / ports / habitats)", value: "not assessed", category: "UNKNOWN" },
    ],
    exposure_assessed: false,
    method: "Heuristic extent categories (<1, <10, <100, >=100 km²). Exposure requires coastline/sensitivity layers that are not bundled.",
  };
}

function buildRecommendations(s: InvestigationState) {
  const out: { priority: "IMMEDIATE" | "HIGH" | "ROUTINE"; action: string; rationale: string }[] = [];
  const f6 = s.forward?.snapshots.find((x) => x.hours === 6) ?? s.forward?.snapshots[0];
  if (s.detection?.synthetic) out.push({ priority: "ROUTINE", action: "Treat all outputs as interface demonstration only.", rationale: "Synthetic scene." });
  if (s.environment?.low_wind_lookalike_risk)
    out.push({ priority: "IMMEDIATE", action: "Verify the slick with an independent observation (aerial surveillance, optical imagery or the next SAR pass) before escalation.", rationale: `Wind ${S(s.environment.at_observation.wind_speed_ms)} m/s at observation: low-wind look-alikes are likely.` });
  if (f6)
    out.push({ priority: "HIGH", action: `Task surveillance over the T+${f6.hours} h forecast centroid ${formatLat(f6.centroid[0], 3)}, ${formatLon(f6.centroid[1], 3)} (P90 radius ${S(f6.r90_km, 1)} km).`, rationale: "Forward forecast envelope." });
  const top = s.attribution?.candidates.slice(0, 3) ?? [];
  if (top.length)
    out.push({ priority: "HIGH", action: `Request full (unclipped) AIS and voyage records for ${top.map((c) => `${c.vessel_name} (MMSI ${c.mmsi})`).join(", ")} for T0-24 h.`, rationale: "Top-ranked investigative leads; ranking is not proof of discharge." });
  if (s.environment?.at_observation?.current_status === "NOT_AVAILABLE")
    out.push({ priority: "HIGH", action: "Acquire CMEMS surface currents (uo, vo) for the incident window and re-run the investigation.", rationale: "Origin and forecast envelopes are dominated by the unknown-current prior." });
  if ((s.environment?.coverage?.backward_window_fraction ?? 1) < 0.5)
    out.push({ priority: "HIGH", action: "Download hourly ERA5 u10/v10 covering T0-48 h to T0+48 h (scripts/download_era5_window.py) and re-run.", rationale: "Most drift steps currently use persisted wind." });
  out.push({ priority: "ROUTINE", action: "If a vessel remains a lead after verification, refer to the competent authority for sampling / port-state inspection.", rationale: "Legal attribution requires physical evidence." });
  out.push({ priority: "ROUTINE", action: "Coastline/sensitive-area exposure: add a coastline layer (e.g. GSHHG) to enable impact-zone exposure analysis.", rationale: "Exposure currently not assessed." });
  return out;
}

// ---------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------

let invCounter = 1;
const store = new Map<string, Investigation>();

export function defaultParams(sceneId: string, partial: Partial<InvestigationParams> = {}): InvestigationParams {
  const clampNum = (x: any, lo: number, hi: number, d: number) => {
    const n = Number(x);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
  };
  const fh = Array.isArray(partial.forecast_hours) && partial.forecast_hours.length
    ? partial.forecast_hours.map(Number).filter((h) => h > 0 && h <= 120).sort((a, b) => a - b)
    : [6, 12, 24, 48];
  return {
    scene_id: sceneId,
    backtrack_hours: clampNum(partial.backtrack_hours, 1, 72, 12),
    forecast_hours: fh.length ? fh : [6, 12, 24, 48],
    num_particles: Math.round(clampNum(partial.num_particles, 20, 2000, DEFAULT_DRIFT_PARAMS.numParticles)),
    timestep_minutes: clampNum(partial.timestep_minutes, 5, 120, 30),
    wind_factor: clampNum(partial.wind_factor, 0, 0.1, 0.03),
    eddy_diffusivity: clampNum(partial.eddy_diffusivity, 0, 100, 2.5),
    unknown_current_sigma: clampNum(partial.unknown_current_sigma, 0, 1, 0.1),
    seed: Math.round(clampNum(partial.seed, 0, 2 ** 31 - 1, 42)),
    weights: normalizeWeights(partial.weights ?? DEFAULT_WEIGHTS),
  };
}

export function createInvestigation(params: InvestigationParams): Investigation {
  const id = `INV-${Date.now().toString(36).toUpperCase()}-${(invCounter++).toString().padStart(3, "0")}`;
  const now = new Date().toISOString();
  const inv: Investigation = {
    id,
    created_at: now,
    updated_at: now,
    status: "running",
    state: { params, warnings: [] },
    events: [],
    node_status: Object.fromEntries(NODES.map((n) => [n.id, "pending" as NodeStatus])),
    listeners: new Set(),
    private: {},
    orchestrator: "deterministic",
    runtime: DETERMINISTIC_RUNTIME,
  };
  store.set(id, inv);
  // keep memory bounded
  if (store.size > 50) {
    const oldest = [...store.keys()][0];
    store.delete(oldest);
  }
  return inv;
}

export function getInvestigation(id: string): Investigation | undefined {
  return store.get(id);
}

function emit(inv: Investigation, e: Omit<NodeEvent, "seq" | "investigation_id" | "at" | "label">) {
  const def = NODES.find((n) => n.id === e.node);
  const full: NodeEvent = { seq: inv.events.length + 1, investigation_id: inv.id, at: new Date().toISOString(), label: def?.label ?? e.node, ...e };
  inv.events.push(full);
  inv.node_status[e.node] = e.status;
  inv.updated_at = full.at;
  for (const l of inv.listeners) {
    try { l(full); } catch { /* listener errors must not break execution */ }
  }
}

const yieldLoop = () => new Promise<void>((r) => setImmediate(r));

export const DETERMINISTIC_RUNTIME =
  "AEGIS deterministic state graph (fallback orchestrator; LangGraph-compatible node contract)";
export const LANGGRAPH_RUNTIME = "LangGraph StateGraph (@langchain/langgraph) orchestrating the AEGIS agent nodes";
const LANGGRAPH_MODULE = "@langchain/langgraph";

type ModuleLoader = (name: string) => Promise<any>;
let moduleLoader: ModuleLoader = (name: string) => import(name);
/** Test hook: replace the module loader (e.g. with a contract stub). */
export function setModuleLoaderForTests(loader: ModuleLoader | null) {
  moduleLoader = loader ?? ((name: string) => import(name));
}

type Outcome = "completed" | "failed" | "skipped";

/** Executes ONE agent node against the real engines. Shared by both orchestrators. */
export async function runNode(inv: Investigation, svc: SceneService, node: NodeDef): Promise<Outcome> {
  inv.private.visited?.add(node.id);
  const missing = node.requires.filter((k) => inv.state[k] === undefined);
  if (missing.length) {
    emit(inv, { node: node.id, status: "skipped", summary: `Skipped: required input missing (${missing.join(", ")}).` });
    return "skipped";
  }
  emit(inv, { node: node.id, status: "running" });
  await yieldLoop();
  const t = performance.now();
  try {
    const r = node.run(inv, svc);
    Object.assign(inv.state, r.patch);
    if (r.warnings?.length) inv.state.warnings.push(...r.warnings.map((w) => `[${node.label}] ${w}`));
    emit(inv, {
      node: node.id,
      status: "completed",
      duration_ms: Math.round((performance.now() - t) * 100) / 100,
      summary: r.summary,
      evidence: r.evidence,
      warnings: r.warnings,
      data_sources: r.data_sources,
      confidence: r.confidence,
    });
    return "completed";
  } catch (error) {
    emit(inv, { node: node.id, status: "failed", duration_ms: Math.round((performance.now() - t) * 100) / 100, error: (error as Error).message });
    inv.state.warnings.push(`[${node.label}] FAILED: ${(error as Error).message}`);
    return "failed";
  }
}

/** Routing rules (identical for both orchestrators). null = END. */
export function nextNodeId(node: NodeDef, outcome: Outcome, state: InvestigationState): string | null {
  if (outcome === "failed" && node.id === "satellite_detection") return "report_generation";
  if (outcome === "completed" && node.route) {
    const r = node.route(state);
    if (r) return r;
  }
  const i = NODES.findIndex((n) => n.id === node.id);
  return i >= 0 && i + 1 < NODES.length ? NODES[i + 1].id : null;
}

async function executeDeterministic(inv: Investigation, svc: SceneService, startIdx: number) {
  let id: string | null = NODES[startIdx].id;
  const seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id);
    const node = NODES.find((n) => n.id === id)!;
    const outcome = await runNode(inv, svc, node);
    id = nextNodeId(node, outcome, inv.state);
    await yieldLoop();
  }
}

/** LangGraph adapter: every AEGIS agent is a StateGraph node; edges use nextNodeId(). */
async function executeWithLangGraph(lg: any, inv: Investigation, svc: SceneService, startIdx: number) {
  const { StateGraph, Annotation, START, END } = lg;
  const active = NODES.slice(startIdx);
  const ids = active.map((n) => n.id);
  const Channels = Annotation.Root({ last: Annotation(), outcome: Annotation() });
  const graph = new StateGraph(Channels);
  for (const node of active) {
    graph.addNode(node.id, async () => {
      if (inv.orchestrator_info) inv.orchestrator_info.graph_node_invocations++;
      return { last: node.id, outcome: await runNode(inv, svc, node) };
    });
  }
  graph.addEdge(START, active[0].id);
  for (const node of active) {
    graph.addConditionalEdges(
      node.id,
      (st: { outcome: Outcome }) => {
        const nxt = nextNodeId(node, st.outcome, inv.state);
        return nxt && ids.includes(nxt) ? nxt : END;
      },
      [...ids, END],
    );
  }
  const app = graph.compile();
  await app.invoke({ last: "", outcome: "" }, { recursionLimit: NODES.length * 2 + 5 });
}

async function resolveOrchestrator(): Promise<{ kind: "deterministic" | "langgraph"; runtime: string; lg?: any; note?: string }> {
  // AEGIS_ORCHESTRATOR: "auto" (default) = real LangGraph when it loads, else the labelled deterministic fallback;
  // "langgraph" = same, but a load failure is reported loudly; "deterministic" = force the fallback.
  const wanted = String(process.env.AEGIS_ORCHESTRATOR || "auto").toLowerCase();
  if (wanted === "deterministic") return { kind: "deterministic", runtime: DETERMINISTIC_RUNTIME, note: "AEGIS_ORCHESTRATOR=deterministic: LangGraph not used by request." };
  try {
    const lg = await moduleLoader(LANGGRAPH_MODULE);
    if (!lg || typeof lg.StateGraph !== "function" || typeof lg.Annotation !== "function") {
      throw new Error("module does not export StateGraph/Annotation");
    }
    return { kind: "langgraph", runtime: LANGGRAPH_RUNTIME, lg };
  } catch (e) {
    const msg = (e as Error).message.split("\n")[0].slice(0, 160);
    return {
      kind: "deterministic",
      runtime: `${DETERMINISTIC_RUNTIME} - LangGraph not available`,
      note: `${LANGGRAPH_MODULE} could not be loaded (${msg}); the deterministic fallback orchestrator ran instead (ORCHESTRATOR = DETERMINISTIC_FALLBACK).`,
    };
  }
}

/**
 * Execute the graph. `startAt` resumes from a node using the stored state
 * (human-in-the-loop re-run, e.g. after the investigator changes weights).
 */
export async function executeInvestigation(inv: Investigation, svc: SceneService, startAt?: string): Promise<Investigation> {
  inv.status = "running";
  const startIdx = startAt ? Math.max(0, NODES.findIndex((n) => n.id === startAt)) : 0;
  const orch = await resolveOrchestrator();
  inv.orchestrator = orch.kind;
  inv.runtime = orch.runtime;
  inv.orchestrator_info = {
    status: orch.kind === "langgraph" ? "LANGGRAPH" : "DETERMINISTIC_FALLBACK",
    requested: String(process.env.AEGIS_ORCHESTRATOR || "auto").toLowerCase(),
    package: orch.kind === "langgraph" ? LANGGRAPH_MODULE : null,
    package_version: orch.kind === "langgraph" ? installedVersion(LANGGRAPH_MODULE) : null,
    core_version: orch.kind === "langgraph" ? installedVersion("@langchain/core") : null,
    graph_node_invocations: 0,
    llm_used: false,
    node_kind: "RULE_BASED_COMPUTATION",
    note: orch.note ?? null,
  };
  if (orch.note && !inv.state.warnings.includes(`[Orchestrator] ${orch.note}`)) inv.state.warnings.push(`[Orchestrator] ${orch.note}`);
  inv.private.visited = new Set();
  if (orch.kind === "langgraph") await executeWithLangGraph(orch.lg, inv, svc, startIdx);
  else await executeDeterministic(inv, svc, startIdx);
  // nodes after the start that the routing did not visit in THIS run
  for (const n of NODES.slice(startIdx)) {
    if (!inv.private.visited.has(n.id)) emit(inv, { node: n.id, status: "skipped", summary: "Not on the routed path in this run (conditional routing)." });
  }
  inv.status = inv.node_status["satellite_detection"] === "failed" ? "failed" : "completed";
  inv.updated_at = new Date().toISOString();
  for (const l of inv.listeners) {
    try { l({ type: "complete" }); } catch { /* ignore */ }
  }
  return inv;
}

/** Reader-facing pipeline stage of each node (the graph itself is unchanged). Counterfactual checks run on demand (POST /api/investigations/:id/counterfactual). */
export const STAGE_OF: Record<string, string> = {
  satellite_detection: "Scene Intake + SAR Evidence",
  spill_characterization: "SAR Evidence",
  environmental_analysis: "Environment Evidence",
  backward_origin: "Drift Physics",
  forward_forecast: "Drift Physics",
  ais_investigation: "AIS Evidence",
  evidence_fusion: "Attribution Reasoning",
  uncertainty: "Attribution Reasoning",
  competing_hypotheses: "Attribution Reasoning",
  risk_assessment: "Attribution Reasoning",
  response_recommendation: "Attribution Reasoning",
  report_generation: "Report",
};

/** Public JSON view (no private data, no listeners). */
export function investigationView(inv: Investigation) {
  return {
    investigation_id: inv.id,
    status: inv.status,
    created_at: inv.created_at,
    updated_at: inv.updated_at,
    graph: {
      runtime: inv.runtime,
      orchestrator: inv.orchestrator,
      orchestrator_status: inv.orchestrator_info?.status ?? "DETERMINISTIC_FALLBACK",
      orchestrator_info: inv.orchestrator_info ?? null,
      stages: ["Scene Intake + SAR Evidence", "SAR Evidence", "Environment Evidence", "Drift Physics", "AIS Evidence", "Attribution Reasoning", "Counterfactual Checks (on demand)", "Report"],
      nodes: NODES.map((n) => ({ id: n.id, label: n.label, stage: STAGE_OF[n.id] ?? null, kind: "RULE_BASED_COMPUTATION", description: n.description, requires: n.requires, conditional: !!n.route, status: inv.node_status[n.id] })),
    },
    events: inv.events,
    state: inv.state,
  };
}
