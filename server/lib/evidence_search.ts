/**
 * Deterministic evidence search over an existing investigation state.
 *
 * This is a pure lookup/filter layer: every value it returns was already computed by the investigation
 * engines and is copied verbatim. It never calls a language model, never ranks by anything other than the
 * engine's own scores, and never produces a vessel, position, timestamp or score that is not already in
 * the state. If a query cannot be answered from the state, it says so.
 *
 * Pure module (no Node built-ins) so the browser can use it directly on the state it already holds.
 */

export type EvidenceIntent =
  | "top_candidates"
  | "vessel_detail"
  | "closest_to_origin"
  | "ais_evidence"
  | "missing_evidence"
  | "spill_summary"
  | "help";

export interface EvidenceFact {
  label: string;
  value: string;
  tone?: "ok" | "warn" | "danger" | "neutral";
}

export interface EvidenceHit {
  kind: "vessel" | "fact";
  mmsi?: string;
  title: string;
  subtitle?: string;
  score?: number;
  priority?: string;
  supporting: string[];
  contradicting: string[];
  facts: EvidenceFact[];
}

export interface EvidenceAnswer {
  query: string;
  intent: EvidenceIntent;
  headline: string;
  hits: EvidenceHit[];
  notes: string[];
  /** Examples shown when the query was not understood. */
  suggestions?: string[];
  disclaimer: string;
}

const DISCLAIMER =
  "Every value above was computed by the investigation engines and is reported unchanged. Candidate rankings are " +
  "investigative leads based on spatio-temporal compatibility; they are not probabilities of guilt and not legal attribution.";

const SUGGESTIONS = [
  "Which vessels have the strongest evidence?",
  "Why is this vessel a candidate?",
  "Show evidence for MSC LEIGH",
  "Which vessels were closest to the spill origin?",
  "Show the AIS evidence",
  "What evidence is missing?",
];

const n = (x: unknown, d = 2): string => (typeof x === "number" && Number.isFinite(x) ? x.toFixed(d) : "n/a");

function vesselHit(c: any): EvidenceHit {
  const m = c.metrics ?? {};
  const q = c.ais_quality ?? {};
  return {
    kind: "vessel",
    mmsi: c.mmsi,
    title: `#${c.rank} ${c.vessel_name}`,
    subtitle: `MMSI ${c.mmsi} · ${c.vessel_type ?? "type not reported"}`,
    score: c.composite_score,
    priority: c.priority_level,
    supporting: c.why_priority ?? [],
    contradicting: c.contradicting_evidence ?? [],
    facts: [
      { label: "Closest approach to slick", value: `${n(m.min_distance_to_slick_km)} km`, tone: (m.min_distance_to_slick_km ?? 99) < 5 ? "warn" : "neutral" },
      { label: "Time vs SAR observation", value: `${(m.time_delta_hours ?? 0) > 0 ? "+" : ""}${n(m.time_delta_hours, 1)} h` },
      { label: "Enters backtracked origin corridor", value: m.intersects_origin ? "yes" : "no", tone: m.intersects_origin ? "warn" : "neutral" },
      {
        label: "Distance to corridor centre",
        value: m.corridor_min_distance_km == null ? "no AIS positions in the window" : `${n(m.corridor_min_distance_km)} km (P90 radius ${n(m.corridor_r90_at_best_km)} km)`,
      },
      { label: "Course vs slick axis", value: m.course_slick_axis_difference_deg == null ? "n/a" : `${n(m.course_slick_axis_difference_deg, 0)}°` },
      { label: "AIS coverage of the window", value: `${q.quality_label ?? "n/a"} · ${Math.round((q.window_coverage_fraction ?? 0) * 100)} % covered, max gap ${n(q.max_gap_in_window_min, 0)} min`, tone: q.quality_label === "GOOD" ? "ok" : q.quality_label === "FAIR" ? "warn" : "danger" },
      { label: "Rank stability (leave one factor out)", value: c.sensitivity ? `${c.sensitivity.rank_min}–${c.sensitivity.rank_max} ${c.sensitivity.stable ? "(stable)" : "(unstable)"}` : "n/a" },
      { label: "Causation", value: c.causality_status ?? "NOT CONFIRMED", tone: "neutral" },
    ],
  };
}

function factHit(title: string, facts: EvidenceFact[], subtitle?: string): EvidenceHit {
  return { kind: "fact", title, subtitle, supporting: [], contradicting: [], facts };
}

/** Classify the query with simple keyword rules. Deterministic and inspectable on purpose. */
export function classify(query: string): EvidenceIntent {
  const q = query.toLowerCase().trim();
  if (!q) return "help";
  if (/(missing|gap|absent|not assessed|what.*need)/.test(q)) return "missing_evidence";
  if (/\bais\b|transponder|track quality|coverage/.test(q)) return "ais_evidence";
  if (/(closest|nearest|near).*(origin|source|release)|origin.*(closest|nearest)/.test(q)) return "closest_to_origin";
  if (/(spill|slick|detection|area|where).*(summary|what|how big|size)|^(what|where) (is|was) the (spill|slick)/.test(q)) return "spill_summary";
  if (/(why|evidence for|show evidence|about vessel|dossier|explain)/.test(q)) return "vessel_detail";
  if (/(strongest|highest|top|best|ranked|priority|which vessel)/.test(q)) return "top_candidates";
  return "vessel_detail"; // a bare name/MMSI is the most common free-text query
}

/** Find a vessel by MMSI or by (partial) name, case-insensitive. */
function findVessels(candidates: any[], query: string): any[] {
  const q = query.toLowerCase();
  const mmsi = q.match(/\b\d{7,9}\b/)?.[0];
  if (mmsi) {
    const byMmsi = candidates.filter((c) => String(c.mmsi) === mmsi);
    if (byMmsi.length) return byMmsi;
  }
  const words = q.replace(/[^\w\s]/g, " ").split(/\s+/).filter((w) => w.length >= 3);
  const scored = candidates
    .map((c) => {
      const name = String(c.vessel_name ?? "").toLowerCase();
      if (!name) return { c, hits: 0 };
      if (q.includes(name)) return { c, hits: 100 };
      const hits = words.filter((w) => name.includes(w)).length;
      return { c, hits };
    })
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits || a.c.rank - b.c.rank);
  return scored.map((x) => x.c);
}

export function searchEvidence(state: any, query: string): EvidenceAnswer {
  const intent = classify(query);
  const base = { query, intent, notes: [] as string[], disclaimer: DISCLAIMER };
  const att = state?.attribution;
  const candidates: any[] = att?.candidates ?? att?.top_candidates ?? [];

  if (intent === "help" || !state) {
    return { ...base, intent: "help", headline: "Ask about this investigation", hits: [], suggestions: SUGGESTIONS };
  }

  // ---------------------------------------------------------------- missing evidence
  if (intent === "missing_evidence") {
    const facts: EvidenceFact[] = [];
    const seen = new Set<string>();
    for (const h of state.hypotheses ?? []) {
      for (const m of h.missing_evidence ?? []) {
        if (!seen.has(m)) {
          seen.add(m);
          facts.push({ label: `${h.id} needs`, value: m, tone: "warn" });
        }
      }
    }
    for (const c of state.uncertainty?.components ?? []) {
      if (c.level === "HIGH") facts.push({ label: `Uncertainty: ${c.component}`, value: c.basis, tone: "warn" });
    }
    for (const w of (state.warnings ?? []).slice(0, 6)) facts.push({ label: "Warning", value: w, tone: "warn" });
    return {
      ...base,
      headline: facts.length ? `${facts.length} evidence gaps recorded by this investigation` : "No evidence gaps are recorded in this investigation",
      hits: facts.length ? [factHit("Evidence gaps and limitations", facts)] : [],
      notes: ["Gaps are taken from the competing hypotheses, the uncertainty assessment and the node warnings."],
    };
  }

  // ---------------------------------------------------------------- AIS evidence
  if (intent === "ais_evidence") {
    const ais = state.ais;
    if (!ais) return { ...base, headline: "No AIS evidence in this investigation", hits: [], notes: ["The AIS node did not run or produced no data for this scene."] };
    const facts: EvidenceFact[] = [
      { label: "Source", value: String(ais.source ?? "n/a") },
      { label: "File", value: String(ais.file ?? "n/a") },
      { label: "Reports / vessels", value: `${ais.records ?? 0} reports from ${ais.vessels ?? 0} vessels` },
      { label: "Active in the analysis window", value: `${ais.vessels_active_in_window ?? 0} vessels` },
      { label: "Spatial extent", value: ais.spatial_extent ? `clipped to ${JSON.stringify(ais.spatial_extent)}` : "not clipped", tone: ais.spatial_extent ? "warn" : "neutral" },
      { label: "Synthetic", value: ais.synthetic ? "yes - demo data" : "no", tone: ais.synthetic ? "warn" : "ok" },
    ];
    const byQuality = candidates.slice(0, 8).map((c) => ({
      label: `${c.vessel_name} (MMSI ${c.mmsi})`,
      value: `${c.ais_quality?.quality_label ?? "n/a"} · ${c.ais_quality?.n_points ?? 0} reports, ${Math.round((c.ais_quality?.window_coverage_fraction ?? 0) * 100)} % of the window`,
      tone: (c.ais_quality?.quality_label === "GOOD" ? "ok" : c.ais_quality?.quality_label === "FAIR" ? "warn" : "danger") as EvidenceFact["tone"],
    }));
    return {
      ...base,
      headline: `AIS evidence: ${ais.records ?? 0} reports from ${ais.vessels ?? 0} vessels`,
      hits: [factHit("AIS source and coverage", facts), ...(byQuality.length ? [factHit("Per-vessel AIS track quality", byQuality)] : [])],
      notes: ais.spatial_extent ? ["Vessels outside the AIS extract's bounding box cannot appear in this analysis."] : [],
    };
  }

  // ---------------------------------------------------------------- spill summary
  if (intent === "spill_summary") {
    const d = state.detection;
    if (!d) return { ...base, headline: "No detection in this investigation", hits: [] };
    const g = d.geometry ?? {};
    const b = state.backward;
    const facts: EvidenceFact[] = [
      { label: "Observed area", value: `${n(g.area_km2)} km²` },
      { label: "Centroid", value: `${n(g.centroid?.[0], 4)}, ${n(g.centroid?.[1], 4)}` },
      { label: "Observation time", value: String(d.detection_time ?? "n/a") },
      { label: "Outline provenance", value: String(d.geometry_source ?? "n/a") },
    ];
    if (b) {
      facts.push({ label: "Probable origin", value: `${n(b.final?.centroid?.[0], 4)}, ${n(b.final?.centroid?.[1], 4)} (P90 radius ${n(b.final?.r90_km)} km at T−${n(b.hours, 0)} h)` });
    }
    return { ...base, headline: `Slick ${n(g.area_km2)} km² detected`, hits: [factHit("Spill summary", facts)] };
  }

  if (!candidates.length) {
    return {
      ...base,
      headline: "No candidate vessels were scored in this investigation",
      hits: [],
      notes: ["Attribution needs an AIS extract for the scene. For uploaded images without AIS, additional investigation data is required."],
    };
  }

  // ---------------------------------------------------------------- closest to origin
  if (intent === "closest_to_origin") {
    const ranked = candidates
      .filter((c) => c.metrics?.corridor_min_distance_km != null)
      .sort((a, b) => a.metrics.corridor_min_distance_km - b.metrics.corridor_min_distance_km)
      .slice(0, 5);
    if (!ranked.length) {
      return { ...base, headline: "No vessel had AIS positions inside the backtrack window", hits: [], notes: ["Corridor distance can only be computed where a vessel reported positions during the backtracked window."] };
    }
    return {
      ...base,
      headline: `${ranked.length} vessels ranked by distance to the backtracked origin corridor`,
      hits: ranked.map(vesselHit),
      notes: ["Ordered by distance to the corridor centre, which is not the same as the composite ranking."],
    };
  }

  // ---------------------------------------------------------------- one vessel
  if (intent === "vessel_detail") {
    const matches = findVessels(candidates, query);
    if (matches.length) {
      return {
        ...base,
        headline: matches.length === 1 ? `Evidence for ${matches[0].vessel_name}` : `${matches.length} vessels match "${query}"`,
        hits: matches.slice(0, 5).map(vesselHit),
      };
    }
    return {
      ...base,
      intent: "top_candidates",
      headline: `No vessel in this investigation matches "${query}" — showing the strongest evidence instead`,
      hits: candidates.slice(0, 5).map(vesselHit),
      suggestions: SUGGESTIONS,
      notes: [`${candidates.length} vessels were scored; none matched that name or MMSI.`],
    };
  }

  // ---------------------------------------------------------------- top candidates
  const top = candidates.slice(0, 5);
  const gap = att?.score_gap_top2;
  const notes: string[] = [];
  if (typeof gap === "number" && gap < 0.05) {
    notes.push(`The top two candidates are separated by only ${gap.toFixed(3)}, so the evidence does not single out one vessel.`);
  }
  const highCount = candidates.filter((c) => c.priority_level === "HIGH PRIORITY CANDIDATE").length;
  if (highCount >= 3) notes.push(`${highCount} vessels are rated HIGH priority.`);
  return {
    ...base,
    intent: "top_candidates",
    headline: `Top ${top.length} of ${candidates.length} scored vessels by compatibility`,
    hits: top.map(vesselHit),
    notes,
  };
}
