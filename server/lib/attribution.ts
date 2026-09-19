/**
 * Explainable, deterministic candidate-vessel scoring.
 *
 * Output is a PRIORITISATION of investigative leads, never a finding of
 * responsibility. Every factor is exposed with its raw measurement.
 *
 * Factors (each 0..1):
 *   F1 spatial     closest approach of the AIS track to the OBSERVED slick
 *                  polygon (0 km if the track crosses it); linear decay to 0
 *                  at 25 km (same scale as the 2018 offline analysis).
 *   F2 temporal    time of that closest approach relative to the SAR
 *                  observation T0: 1 inside [T0 - H, T0 + 0.5 h] (H = backtrack
 *                  horizon), linear decay to 0 over 3 h outside.
 *   F3 trajectory  space-time consistency with the BACKTRACKED drift corridor:
 *                  for t in [T0 - H, T0], distance between the vessel's
 *                  interpolated AIS position and the corridor centroid at t,
 *                  minus the corridor's P90 radius at t. 1 when the vessel is
 *                  inside the envelope; exp(-excess / 3 km) otherwise.
 *   F4 kinematic   axial alignment of the vessel's course (COG) at closest
 *                  approach with the slick's principal axis (1 - diff/90).
 *                  Neutral 0.5 when the vessel was effectively stationary.
 *
 * Scene-level environmental consistency (wind vs slick axis) is identical for
 * every vessel, so it is reported as scene evidence and NOT added to the
 * vessel composite (it cannot discriminate between vessels).
 */

import { LonLat, LatLon, haversineKm, distanceToRingKm, axialDifference, clamp01, round } from "./geo";
import { VesselTrack, positionAt, trackQuality, AisQuality } from "./ais";
import { CentroidPathPoint } from "./drift";

export interface Weights {
  spatial: number;
  temporal: number;
  trajectory: number;
  consistency: number;
}

export const DEFAULT_WEIGHTS: Weights = { spatial: 0.35, temporal: 0.25, trajectory: 0.25, consistency: 0.15 };

export function normalizeWeights(w: Partial<Weights>): Weights {
  const raw = {
    spatial: Math.max(0, Number(w.spatial ?? DEFAULT_WEIGHTS.spatial) || 0),
    temporal: Math.max(0, Number(w.temporal ?? DEFAULT_WEIGHTS.temporal) || 0),
    trajectory: Math.max(0, Number(w.trajectory ?? DEFAULT_WEIGHTS.trajectory) || 0),
    consistency: Math.max(0, Number(w.consistency ?? DEFAULT_WEIGHTS.consistency) || 0),
  };
  const s = raw.spatial + raw.temporal + raw.trajectory + raw.consistency;
  if (s <= 0) return { ...DEFAULT_WEIGHTS };
  return {
    spatial: raw.spatial / s,
    temporal: raw.temporal / s,
    trajectory: raw.trajectory / s,
    consistency: raw.consistency / s,
  };
}

export interface AttributionContext {
  obsTimeMs: number;
  slickRing: LonLat[];
  /** Optional: all polygons of a multi-part slick; closest approach is the minimum over them. */
  slickRings?: LonLat[][];
  slickCentroid: LatLon;
  slickAxisDeg: number;
  corridor: CentroidPathPoint[];
  horizonHours: number;
  aisBbox: [number, number, number, number] | null;
  baseline: Map<string, number>;
  dataSourceLabel: string;
}

export const SPATIAL_SCALE_KM = 25;
export const TEMPORAL_DECAY_H = 3;
export const CORRIDOR_DECAY_KM = 3;
export const CORRIDOR_SAMPLE_MIN = 10;
export const STATIONARY_SOG_KN = 0.5;

export type PriorityLevel = "HIGH PRIORITY CANDIDATE" | "MEDIUM PRIORITY CANDIDATE" | "LOW PRIORITY";

export function priorityOf(score: number): { level: PriorityLevel; color: "red" | "amber" | "slate" } {
  if (score >= 0.75) return { level: "HIGH PRIORITY CANDIDATE", color: "red" };
  if (score >= 0.5) return { level: "MEDIUM PRIORITY CANDIDATE", color: "amber" };
  return { level: "LOW PRIORITY", color: "slate" };
}

function corridorAt(corridor: CentroidPathPoint[], tMs: number): { lat: number; lon: number; r90: number } | null {
  if (!corridor.length) return null;
  const pts = corridor.map((c) => ({ t: Date.parse(c.time), c })).sort((a, b) => a.t - b.t);
  if (tMs < pts[0].t || tMs > pts[pts.length - 1].t) return null;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (tMs >= a.t && tMs <= b.t) {
      const w = b.t === a.t ? 0 : (tMs - a.t) / (b.t - a.t);
      return {
        lat: a.c.lat + (b.c.lat - a.c.lat) * w,
        lon: a.c.lon + (b.c.lon - a.c.lon) * w,
        r90: a.c.r90_km + (b.c.r90_km - a.c.r90_km) * w,
      };
    }
  }
  const last = pts[pts.length - 1].c;
  return { lat: last.lat, lon: last.lon, r90: last.r90_km };
}

export interface VesselEvidence {
  rank: number;
  mmsi: string;
  vessel_name: string;
  vessel_type: string;
  imo?: string;
  flag?: string;
  length_m: number | null;
  width_m: number | null;
  synthetic: boolean;
  composite_score: number;
  priority_level: PriorityLevel;
  priority_color: "red" | "amber" | "slate";
  feature_breakdown: {
    spatial_proximity_score: number;
    temporal_alignment_score: number;
    trajectory_intersection_score: number;
    kinematic_consistency_score: number;
    weights_used: Weights;
    weighted_contributions: Weights;
  };
  metrics: {
    min_distance_to_origin_km: number;
    min_distance_to_slick_km: number;
    min_distance_to_slick_centroid_km: number;
    time_delta_hours: number;
    cpa_timestamp: string;
    cpa_speed_knots: number;
    cpa_course_deg: number | null;
    cpa_coordinates: [number, number];
    course_slick_axis_difference_deg: number | null;
    intersects_origin: boolean;
    corridor_min_distance_km: number | null;
    corridor_r90_at_best_km: number | null;
    corridor_best_time: string | null;
    corridor_samples_with_position: number;
  };
  ais_quality: AisQuality;
  baseline_offline_score: number | null;
  why_priority: string[];
  contradicting_evidence: string[];
  evidence_narrative: string[];
  sensitivity: {
    rank_without_spatial: number;
    rank_without_temporal: number;
    rank_without_trajectory: number;
    rank_without_kinematic: number;
    rank_min: number;
    rank_max: number;
    stable: boolean;
  };
  /** Exact Shapley values of the LINEAR composite (baseline = mean factor values over scored vessels). */
  explanation: {
    method: string;
    base_value: number;
    contributions: Weights;
    additivity_error: number;
  };
  scientific_disclaimer: string;
  track_coordinates: LonLat[];
  causality_status: "NOT CONFIRMED";
}

interface RawFactors {
  track: VesselTrack;
  f: Weights;
  cpaSlickKm: number;
  cpaCentroidKm: number;
  cpaTime: number;
  cpaIdx: number;
  corridorMinKm: number | null;
  corridorR90: number | null;
  corridorBest: number | null;
  corridorSamples: number;
  corridorIntersects: boolean;
  courseDiff: number | null;
  stationary: boolean;
  quality: AisQuality;
}

function computeFactors(track: VesselTrack, ctx: AttributionContext): RawFactors | null {
  const pts = track.points;
  if (pts.length < 2) return null;

  // F1: closest approach to the observed slick polygon
  let cpaSlick = Infinity;
  let cpaIdx = 0;
  for (let i = 0; i < pts.length; i++) {
    const rings = (ctx.slickRings && ctx.slickRings.length ? ctx.slickRings : [ctx.slickRing]).filter((r) => r.length >= 4);
    const d = rings.length
      ? Math.min(...rings.map((r) => distanceToRingKm(pts[i].lat, pts[i].lon, r)))
      : haversineKm(pts[i].lat, pts[i].lon, ctx.slickCentroid[0], ctx.slickCentroid[1]);
    if (d < cpaSlick) { cpaSlick = d; cpaIdx = i; }
  }
  const cpa = pts[cpaIdx];
  const f1 = clamp01(1 - cpaSlick / SPATIAL_SCALE_KM);

  // F2: timing of that approach relative to [T0 - H, T0 + 0.5 h]
  const winStart = ctx.obsTimeMs - ctx.horizonHours * 3600e3;
  const winEnd = ctx.obsTimeMs + 0.5 * 3600e3;
  let outsideH = 0;
  if (cpa.t < winStart) outsideH = (winStart - cpa.t) / 3600e3;
  else if (cpa.t > winEnd) outsideH = (cpa.t - winEnd) / 3600e3;
  const f2 = clamp01(1 - outsideH / TEMPORAL_DECAY_H);

  // F3: space-time consistency with the backtracked corridor
  let best: number | null = null;
  let bestR90: number | null = null;
  let bestT: number | null = null;
  let bestExcess = Infinity;
  let samples = 0;
  for (let t = winStart; t <= ctx.obsTimeMs + 1; t += CORRIDOR_SAMPLE_MIN * 60e3) {
    const pos = positionAt(track, t);
    const cor = corridorAt(ctx.corridor, t);
    if (!pos || !cor) continue;
    samples++;
    const d = haversineKm(pos.lat, pos.lon, cor.lat, cor.lon);
    const excess = Math.max(0, d - cor.r90);
    if (excess < bestExcess || (excess === bestExcess && best !== null && d < best)) {
      bestExcess = excess; best = d; bestR90 = cor.r90; bestT = t;
    }
  }
  const f3 = samples === 0 ? 0 : Math.exp(-bestExcess / CORRIDOR_DECAY_KM);

  // F4: course alignment with slick axis at closest approach
  const stationary = cpa.sog !== null && cpa.sog < STATIONARY_SOG_KN;
  const courseDiff = cpa.cog !== null ? axialDifference(cpa.cog, ctx.slickAxisDeg) : null;
  const f4 = stationary || courseDiff === null ? 0.5 : clamp01(1 - courseDiff / 90);

  return {
    track,
    f: { spatial: f1, temporal: f2, trajectory: f3, consistency: f4 },
    cpaSlickKm: cpaSlick,
    cpaCentroidKm: haversineKm(cpa.lat, cpa.lon, ctx.slickCentroid[0], ctx.slickCentroid[1]),
    cpaTime: cpa.t,
    cpaIdx,
    corridorMinKm: best,
    corridorR90: bestR90,
    corridorBest: bestT,
    corridorSamples: samples,
    corridorIntersects: samples > 0 && bestExcess === 0,
    courseDiff,
    stationary,
    quality: trackQuality(track, winStart, ctx.obsTimeMs),
  };
}

function composite(f: Weights, w: Weights): number {
  return f.spatial * w.spatial + f.temporal * w.temporal + f.trajectory * w.trajectory + f.consistency * w.consistency;
}

function ranksUnder(all: RawFactors[], w: Weights): Map<string, number> {
  const scored = all.map((r) => ({ mmsi: r.track.mmsi, s: composite(r.f, w) }));
  scored.sort((a, b) => b.s - a.s || a.mmsi.localeCompare(b.mmsi));
  return new Map(scored.map((x, i) => [x.mmsi, i + 1]));
}

function dropFactor(w: Weights, key: keyof Weights): Weights {
  const c = { ...w, [key]: 0 };
  return normalizeWeights(c);
}

const DISCLAIMER =
  "Decision-support ranking only. A high score indicates stronger spatio-temporal and kinematic compatibility in the available AIS record. It does NOT establish that this vessel discharged oil, and must not be used as legal attribution.";

export interface AttributionResult {
  candidates: VesselEvidence[];
  weights_used: Weights;
  total_candidates: number;
  high_priority_count: number;
  medium_priority_count: number;
  excluded_tracks: number;
  factor_definitions: Record<string, string>;
  coverage_warnings: string[];
  score_gap_top2: number | null;
}

export function scoreCandidates(tracks: VesselTrack[], ctx: AttributionContext, weightsIn: Partial<Weights>): AttributionResult {
  const w = normalizeWeights(weightsIn);
  const raws: RawFactors[] = [];
  let excluded = 0;
  for (const t of tracks) {
    const r = computeFactors(t, ctx);
    if (r) raws.push(r);
    else excluded++;
  }

  const baseRanks = ranksUnder(raws, w);
  const rs = ranksUnder(raws, dropFactor(w, "spatial"));
  const rt = ranksUnder(raws, dropFactor(w, "temporal"));
  const rj = ranksUnder(raws, dropFactor(w, "trajectory"));
  const rk = ranksUnder(raws, dropFactor(w, "consistency"));

  // Exact Shapley values: for f(x) = sum_i w_i x_i with baseline E[x] over the scored
  // vessels, phi_i = w_i (x_i - E[x_i]); base + sum(phi) = f(x) exactly.
  const keys: (keyof Weights)[] = ["spatial", "temporal", "trajectory", "consistency"];
  const meanF = Object.fromEntries(keys.map((k) => [k, raws.length ? raws.reduce((a, r) => a + r.f[k], 0) / raws.length : 0])) as unknown as Weights;
  const baseValue = keys.reduce((a, k) => a + w[k] * meanF[k], 0);

  const coverageWarnings: string[] = [];
  if (ctx.aisBbox) {
    const [minLon, minLat, maxLon, maxLat] = ctx.aisBbox;
    const outside = ctx.corridor.filter((c) => c.lon < minLon || c.lon > maxLon || c.lat < minLat || c.lat > maxLat);
    if (outside.length)
      coverageWarnings.push(
        `The backtracked corridor leaves the AIS extract's bounding box for ${outside.length} of ${ctx.corridor.length} time steps; vessels outside the box are invisible to this analysis.`,
      );
    coverageWarnings.push(
      `AIS extract is spatially clipped to [${minLon}, ${minLat}, ${maxLon}, ${maxLat}]; tracks are truncated at the box edge.`,
    );
  }

  const candidates: VesselEvidence[] = raws.map((r) => {
    const score = composite(r.f, w);
    const pr = priorityOf(score);
    const cpa = r.track.points[r.cpaIdx];
    const m = r.track.meta;
    const hoursFromT0 = (cpa.t - ctx.obsTimeMs) / 3600e3;

    const why: string[] = [];
    const against: string[] = [];
    if (r.cpaSlickKm === 0) why.push("AIS track crosses the observed slick polygon.");
    else if (r.f.spatial >= 0.7) why.push(`Closest approach ${r.cpaSlickKm.toFixed(2)} km from the observed slick.`);
    else against.push(`Closest approach to the slick is ${r.cpaSlickKm.toFixed(1)} km.`);

    if (r.f.temporal >= 0.99) why.push(`That approach (${hoursFromT0 >= 0 ? "+" : ""}${hoursFromT0.toFixed(1)} h from SAR time) lies inside the backtrack window.`);
    else if (hoursFromT0 > 0.5) against.push(`Closest approach occurred ${hoursFromT0.toFixed(1)} h AFTER the SAR observation; the slick already existed.`);
    else against.push(`Closest approach is ${Math.abs(hoursFromT0).toFixed(1)} h before T0, outside the ${ctx.horizonHours} h backtrack window.`);

    if (r.corridorSamples === 0) against.push("No AIS positions (gap <= 30 min) during the backtrack window: corridor consistency cannot be assessed.");
    else if (r.corridorIntersects) why.push(`Track enters the backtracked P90 origin corridor (${r.corridorMinKm!.toFixed(2)} km from corridor centre, radius ${r.corridorR90!.toFixed(2)} km at ${new Date(r.corridorBest!).toISOString().slice(11, 16)} UTC).`);
    else if (r.f.trajectory >= 0.5) why.push(`Track passes ${(r.corridorMinKm! - r.corridorR90!).toFixed(2)} km outside the backtracked corridor envelope.`);
    else against.push(`Track stays ${(r.corridorMinKm! - r.corridorR90!).toFixed(1)} km outside the backtracked corridor envelope.`);

    if (r.stationary) against.push(`Vessel near-stationary at closest approach (SOG ${cpa.sog?.toFixed(1)} kn): course alignment is undefined.`);
    else if (r.courseDiff !== null && r.courseDiff <= 20) why.push(`Course ${cpa.cog?.toFixed(0)}° is within ${r.courseDiff.toFixed(0)}° of the slick axis.`);
    else if (r.courseDiff !== null) against.push(`Course differs from the slick axis by ${r.courseDiff.toFixed(0)}°.`);

    if (r.quality.quality_label !== "GOOD") against.push(`AIS quality ${r.quality.quality_label}: ${Math.round(r.quality.window_coverage_fraction * 100)} % window coverage, max gap ${r.quality.max_gap_in_window_min} min.`);
    if (m.synthetic) against.push("SYNTHETIC demo vessel — not a real AIS record.");

    const ranks = [rs.get(r.track.mmsi)!, rt.get(r.track.mmsi)!, rj.get(r.track.mmsi)!, rk.get(r.track.mmsi)!];
    const baseRank = baseRanks.get(r.track.mmsi)!;
    const rankMin = Math.min(baseRank, ...ranks);
    const rankMax = Math.max(baseRank, ...ranks);

    const baseline = ctx.baseline.get(r.track.mmsi);
    const narrative = [
      `${ctx.dataSourceLabel}: ${r.track.points.length} AIS reports (${r.quality.first_report.slice(11, 16)}–${r.quality.last_report.slice(11, 16)} UTC).`,
      ...why,
      ...against.map((a) => `Caveat: ${a}`),
      "This is a decision-support candidate ranking, not proof that this vessel caused or discharged oil.",
    ];

    return {
      rank: baseRank,
      mmsi: r.track.mmsi,
      vessel_name: m.vessel_name ?? "UNKNOWN",
      vessel_type: m.vessel_type_label,
      imo: m.imo ?? undefined,
      flag: m.flag ?? undefined,
      length_m: m.length_m,
      width_m: m.width_m,
      synthetic: m.synthetic,
      composite_score: round(score, 3),
      priority_level: pr.level,
      priority_color: pr.color,
      feature_breakdown: {
        spatial_proximity_score: round(r.f.spatial, 3),
        temporal_alignment_score: round(r.f.temporal, 3),
        trajectory_intersection_score: round(r.f.trajectory, 3),
        kinematic_consistency_score: round(r.f.consistency, 3),
        weights_used: { spatial: round(w.spatial, 3), temporal: round(w.temporal, 3), trajectory: round(w.trajectory, 3), consistency: round(w.consistency, 3) },
        weighted_contributions: {
          spatial: round(r.f.spatial * w.spatial, 3),
          temporal: round(r.f.temporal * w.temporal, 3),
          trajectory: round(r.f.trajectory * w.trajectory, 3),
          consistency: round(r.f.consistency * w.consistency, 3),
        },
      },
      metrics: {
        min_distance_to_origin_km: round(r.corridorMinKm ?? r.cpaSlickKm, 3),
        min_distance_to_slick_km: round(r.cpaSlickKm, 3),
        min_distance_to_slick_centroid_km: round(r.cpaCentroidKm, 3),
        time_delta_hours: round(hoursFromT0, 2),
        cpa_timestamp: new Date(cpa.t).toISOString(),
        cpa_speed_knots: cpa.sog ?? 0,
        cpa_course_deg: cpa.cog,
        cpa_coordinates: [cpa.lat, cpa.lon],
        course_slick_axis_difference_deg: r.courseDiff === null ? null : round(r.courseDiff, 1),
        intersects_origin: r.corridorIntersects,
        corridor_min_distance_km: r.corridorMinKm === null ? null : round(r.corridorMinKm, 3),
        corridor_r90_at_best_km: r.corridorR90 === null ? null : round(r.corridorR90, 3),
        corridor_best_time: r.corridorBest === null ? null : new Date(r.corridorBest).toISOString(),
        corridor_samples_with_position: r.corridorSamples,
      },
      ais_quality: r.quality,
      baseline_offline_score: baseline === undefined ? null : round(baseline / 100, 3),
      why_priority: why,
      contradicting_evidence: against,
      evidence_narrative: narrative,
      sensitivity: {
        rank_without_spatial: ranks[0],
        rank_without_temporal: ranks[1],
        rank_without_trajectory: ranks[2],
        rank_without_kinematic: ranks[3],
        rank_min: rankMin,
        rank_max: rankMax,
        stable: rankMax - rankMin <= 2,
      },
      explanation: (() => {
        const phi = Object.fromEntries(keys.map((k) => [k, w[k] * (r.f[k] - meanF[k])])) as unknown as Weights;
        const err = Math.abs(baseValue + keys.reduce((a, k) => a + phi[k], 0) - score);
        return {
          method: "Exact Shapley values of the linear composite score relative to the mean over all scored vessels (not a learned model; SHAP-compatible format)",
          base_value: round(baseValue, 4),
          contributions: { spatial: round(phi.spatial, 4), temporal: round(phi.temporal, 4), trajectory: round(phi.trajectory, 4), consistency: round(phi.consistency, 4) },
          additivity_error: err,
        };
      })(),
      scientific_disclaimer: DISCLAIMER,
      track_coordinates: r.track.points.map((p) => [p.lon, p.lat] as LonLat),
      causality_status: "NOT CONFIRMED",
    };
  });

  candidates.sort((a, b) => a.rank - b.rank);
  const gap = candidates.length >= 2 ? round(candidates[0].composite_score - candidates[1].composite_score, 3) : null;

  return {
    candidates,
    weights_used: w,
    total_candidates: candidates.length,
    high_priority_count: candidates.filter((c) => c.priority_level === "HIGH PRIORITY CANDIDATE").length,
    medium_priority_count: candidates.filter((c) => c.priority_level === "MEDIUM PRIORITY CANDIDATE").length,
    excluded_tracks: excluded,
    factor_definitions: {
      spatial: `Closest approach of the AIS track to the observed slick polygon; 1 at 0 km, 0 at ${SPATIAL_SCALE_KM} km.`,
      temporal: `Timing of that approach: 1 inside [T0 - backtrack horizon, T0 + 0.5 h], linear decay to 0 over ${TEMPORAL_DECAY_H} h outside.`,
      trajectory: `Space-time distance to the backtracked P90 drift corridor, sampled every ${CORRIDOR_SAMPLE_MIN} min; 1 inside the envelope, exp(-excess/${CORRIDOR_DECAY_KM} km) outside.`,
      consistency: `Axial alignment of course over ground with the slick axis (1 - diff/90); 0.5 if SOG < ${STATIONARY_SOG_KN} kn or COG missing.`,
    },
    coverage_warnings: coverageWarnings,
    score_gap_top2: gap,
  };
}

/**
 * Reproduces the 2018 offline analysis (ml/inference/attribution.py) exactly:
 *   0.40 proximity + 0.25 temporal + 0.20 course + 0.15 wind   (0..100)
 * Used as a regression check that this engine reads the same AIS data the
 * same way.
 */
export function reproduceOfflineScore(track: VesselTrack, centroid: LatLon, sarTimeMs: number, slickAxisDeg: number, windScore: number): number | null {
  const pts = track.points;
  if (pts.length < 2) return null;
  let bestD = Infinity;
  let bestI = 0;
  pts.forEach((p, i) => {
    const d = haversineKm(p.lat, p.lon, centroid[0], centroid[1]);
    if (d < bestD) { bestD = d; bestI = i; }
  });
  const c = pts[bestI];
  if (c.cog === null) return null;
  const prox = Math.max(0, 1 - bestD / 25) * 100;
  const temporal = Math.max(0, 1 - Math.abs(c.t - sarTimeMs) / 60000 / 180) * 100;
  const course = Math.max(0, 1 - axialDifference(c.cog, slickAxisDeg) / 90) * 100;
  return 0.4 * prox + 0.25 * temporal + 0.2 * course + 0.15 * windScore;
}
