/**
 * Counterfactual analysis on a completed investigation. Every result is an
 * ANALYTICAL SCENARIO computed with the same engines - not an observation and
 * not a historical fact.
 */
import type { Investigation } from "./investigation";
import { buildHypotheses } from "./investigation";
import type { SceneService } from "./scenes";
import { scoreCandidates, AttributionContext, AttributionResult } from "./attribution";
import { runDrift, CentroidPathPoint } from "./drift";
import { haversineKm, round } from "./geo";

export const CF_LABEL = "ANALYTICAL SCENARIO - computed counterfactual, not an observation or historical fact";

function ctxFor(inv: Investigation, svc: SceneService, corridor: CentroidPathPoint[], horizon: number): AttributionContext {
  const d = inv.state.detection!;
  const a = svc.ais(d.scene_id);
  return {
    obsTimeMs: Date.parse(d.detection_time), slickRing: d.geometry.coordinates, slickRings: d.geometry.parts, slickCentroid: d.geometry.centroid,
    slickAxisDeg: d.geometry.orientation_deg, corridor, horizonHours: horizon, aisBbox: a.bbox,
    baseline: svc.baseline(d.scene_id), dataSourceLabel: a.label,
  };
}

function requireReady(inv: Investigation) {
  const s = inv.state;
  if (!s.detection || !s.backward || !s.attribution) throw new Error("Counterfactuals need a completed investigation with detection, backtrack and attribution.");
}

const brief = (att: AttributionResult, n = 5) =>
  att.candidates.slice(0, n).map((c) => ({ rank: c.rank, mmsi: c.mmsi, vessel_name: c.vessel_name, score: c.composite_score }));

export function excludeVessel(inv: Investigation, svc: SceneService, mmsi: string) {
  requireReady(inv);
  const s = inv.state;
  const tracks = inv.private.tracks ?? svc.ais(s.detection!.scene_id).tracks;
  if (!tracks.some((t) => t.mmsi === mmsi)) throw new Error(`MMSI ${mmsi} is not among the scored vessels`);
  const before = s.attribution!;
  const after = scoreCandidates(tracks.filter((t) => t.mmsi !== mmsi), ctxFor(inv, svc, s.backward!.centroid_path, s.params.backtrack_hours), s.params.weights);
  const hypBefore = s.hypotheses ?? buildHypotheses(s);
  const hypAfter = buildHypotheses({ ...s, attribution: after });
  const excluded = before.candidates.find((c) => c.mmsi === mmsi)!;
  const rankChanges = after.candidates.slice(0, 10).map((c) => {
    const b = before.candidates.find((x) => x.mmsi === c.mmsi)!;
    return { mmsi: c.mmsi, vessel_name: c.vessel_name, rank_before: b.rank, rank_after: c.rank, score: c.composite_score };
  });
  return {
    kind: "exclude_vessel" as const,
    label: CF_LABEL,
    question: `How would the ranking and hypotheses change if ${excluded.vessel_name} (MMSI ${mmsi}) were excluded?`,
    excluded: { mmsi, vessel_name: excluded.vessel_name, rank_before: excluded.rank, score: excluded.composite_score },
    top_before: brief(before),
    top_after: brief(after),
    top_candidate_changed: before.candidates[0]?.mmsi !== after.candidates[0]?.mmsi,
    score_gap_top2_before: before.score_gap_top2,
    score_gap_top2_after: after.score_gap_top2,
    rank_changes_top10: rankChanges,
    hypotheses: hypAfter.map((h) => {
      const b = hypBefore.find((x) => x.id === h.id);
      return { id: h.id, title: h.title, balance_before: b?.evidence_balance ?? null, balance_after: h.evidence_balance, strength_before: b?.evidence_strength ?? null, strength_after: h.evidence_strength };
    }),
    note: "Each vessel's factor scores are computed independently, so excluding a vessel changes ranks, the top-2 separation and the hypothesis evidence - not the other vessels' factor scores.",
  };
}

export function forcingSensitivity(inv: Investigation, svc: SceneService) {
  requireReady(inv);
  const s = inv.state;
  const d = s.detection!;
  const p = s.params;
  const tracks = inv.private.tracks ?? svc.ais(d.scene_id).tracks;
  const particles = Math.min(200, p.num_particles);
  const env = svc.environment(d.scene_id);
  const hasCurrent = env.current.kind !== "none";
  type Sc = { id: string; label: string; wf: number; sigma: number; cs: number };
  const scenarios: Sc[] = hasCurrent
    ? [
        // A current product is connected: the zero-mean prior does not apply, so vary the product itself (what-if cases).
        { id: "as_run", label: `as run (wind factor ${p.wind_factor}, current product x1)`, wf: p.wind_factor, sigma: 0, cs: 1 },
        { id: "no_current", label: "current removed (wind-only transport; what-if)", wf: p.wind_factor, sigma: 0, cs: 0 },
        { id: "current_x0_5", label: "current x0.5 (what-if)", wf: p.wind_factor, sigma: 0, cs: 0.5 },
        { id: "current_x1_5", label: "current x1.5 (what-if)", wf: p.wind_factor, sigma: 0, cs: 1.5 },
        { id: "wind_factor_2pct", label: "wind factor 2 %", wf: 0.02, sigma: 0, cs: 1 },
        { id: "wind_factor_4pct", label: "wind factor 4 %", wf: 0.04, sigma: 0, cs: 1 },
      ]
    : [
        { id: "as_run", label: `as run (wind factor ${p.wind_factor}, current prior sigma ${p.unknown_current_sigma} m/s)`, wf: p.wind_factor, sigma: p.unknown_current_sigma, cs: 1 },
        { id: "wind_only", label: "no current prior (wind-only transport)", wf: p.wind_factor, sigma: 0, cs: 1 },
        { id: "current_prior_0_2", label: "current prior sigma 0.2 m/s", wf: p.wind_factor, sigma: 0.2, cs: 1 },
        { id: "wind_factor_2pct", label: "wind factor 2 %", wf: 0.02, sigma: p.unknown_current_sigma, cs: 1 },
        { id: "wind_factor_4pct", label: "wind factor 4 %", wf: 0.04, sigma: p.unknown_current_sigma, cs: 1 },
      ];
  const runs = scenarios.map((sc) => {
    const back = runDrift(
      { startTimeIso: d.detection_time, seedRing: d.geometry.coordinates, seedRings: d.geometry.parts, seedPoint: d.geometry.centroid, env },
      { mode: "BACKWARD", hours: p.backtrack_hours, timestepMinutes: p.timestep_minutes, numParticles: particles, windFactor: sc.wf, eddyDiffusivity: p.eddy_diffusivity, unknownCurrentSigma: sc.sigma, currentScale: sc.cs, seed: p.seed },
    );
    const att = scoreCandidates(tracks, ctxFor(inv, svc, back.centroid_path, p.backtrack_hours), p.weights);
    return { ...sc, back, att };
  });
  const ref = runs[0];
  const refTop3 = new Set(ref.att.candidates.slice(0, 3).map((c) => c.mmsi));
  const rows = runs.map((r) => ({
    scenario: r.id,
    label: r.label,
    origin_centroid: r.back.final.centroid,
    origin_shift_km: round(haversineKm(r.back.final.centroid[0], r.back.final.centroid[1], ref.back.final.centroid[0], ref.back.final.centroid[1]), 3),
    origin_r90_km: r.back.final.r90_km,
    top_candidate: r.att.candidates[0] ? { mmsi: r.att.candidates[0].mmsi, vessel_name: r.att.candidates[0].vessel_name, score: r.att.candidates[0].composite_score } : null,
    top_candidate_same_as_run: r.att.candidates[0]?.mmsi === ref.att.candidates[0]?.mmsi,
    top3_overlap_with_run: r.att.candidates.slice(0, 3).filter((c) => refTop3.has(c.mmsi)).length,
    score_gap_top2: r.att.score_gap_top2,
  }));
  return {
    kind: "forcing_sensitivity" as const,
    label: CF_LABEL,
    question: "How sensitive is the origin estimate and the vessel ranking to wind/current forcing assumptions?",
    particles_per_scenario: particles,
    seed: p.seed,
    scenarios: rows,
    conclusion_stable: rows.every((r) => r.top_candidate_same_as_run),
    current_product_available: hasCurrent,
    note: hasCurrent
      ? `Each scenario re-runs the backward ensemble (${particles} particles, same seed) and re-scores every vessel. A real historical current product is connected; the current-scaled cases (x0, x0.5, x1.5) are what-if sensitivity scenarios, not data.`
      : `Each scenario re-runs the backward ensemble (${particles} particles, same seed) and re-scores every vessel. No current product exists for this scene, so current is varied only through the zero-mean prior.`,
  };
}
