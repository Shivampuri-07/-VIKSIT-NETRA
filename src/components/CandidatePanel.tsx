import React, { useState } from "react";
import { Ship, Info, Check, X, AlertTriangle, Crosshair, FlaskConical, Sliders } from "lucide-react";
import type { CandidateRanking, VesselScoreDetail } from "../types";
import { fmt, fmtLatLon, utc } from "../lib/format";
import { Disclose, EmptyState, KV, Meter, Tag } from "./ui";

interface CandidatePanelProps {
  attribution: CandidateRanking | null;
  selectedVessel: VesselScoreDetail | null;
  onSelectVessel: (vessel: VesselScoreDetail | null) => void;
  onOpenWeights: () => void;
  onCounterfactual?: (mmsi: string) => void;
  counterfactualBusy?: boolean;
  /** "wide" lays the candidate cards out in a grid for the full-width Evidence view. */
  layout?: "panel" | "wide";
  /** Why there are no candidates, when the investigation ran but attribution was skipped. */
  emptyReason?: string | null;
}

const FACTORS: { key: "spatial" | "temporal" | "trajectory" | "consistency"; label: string; score: keyof VesselScoreDetail["feature_breakdown"]; color: string }[] = [
  { key: "spatial", label: "Spatial", score: "spatial_proximity_score", color: "#1e4e82" },
  { key: "temporal", label: "Temporal", score: "temporal_alignment_score", color: "#2c7a7b" },
  { key: "trajectory", label: "Corridor", score: "trajectory_intersection_score", color: "#5b6ec4" },
  { key: "consistency", label: "Kinematic", score: "kinematic_consistency_score", color: "#b7791f" },
];

const priorityOf = (v: VesselScoreDetail) => {
  if (v.priority_level === "HIGH PRIORITY CANDIDATE") return { text: "High priority", tone: "danger" as const, accent: "#c53030" };
  if (v.priority_level === "MEDIUM PRIORITY CANDIDATE") return { text: "Medium priority", tone: "warn" as const, accent: "#b7791f" };
  return { text: "Low priority", tone: "neutral" as const, accent: "#667085" };
};

const qualityTone = (label?: string) => (label === "GOOD" ? "ok" : label === "FAIR" ? "warn" : "danger") as "ok" | "warn" | "danger";

/**
 * Candidate vessels: ranked investigative leads with their evidence.
 * Scores, factors and text come from the server engine unchanged; this component only presents them.
 */
export const CandidatePanel: React.FC<CandidatePanelProps> = ({
  attribution,
  selectedVessel,
  onSelectVessel,
  onOpenWeights,
  onCounterfactual,
  counterfactualBusy,
  layout = "panel",
  emptyReason,
}) => {
  const [expandedMmsi, setExpandedMmsi] = useState<string | null>(null);

  if (!attribution) {
    return (
      <div className="h-full bg-canvas">
        <EmptyState
          icon={Ship}
          title={emptyReason ? "Additional investigation data required" : "No candidates scored yet"}
          hint={emptyReason ?? "Run the investigation to score AIS tracks against the observed slick and the backtracked origin corridor."}
        />
      </div>
    );
  }

  const wide = layout === "wide";

  return (
    <div className="h-full flex flex-col bg-canvas overflow-hidden select-none">
      {/* Header + summary */}
      <div className="px-4 py-3 border-b border-line bg-surface shrink-0">
        <div className="flex items-center justify-between gap-2 mb-2.5">
          <div>
            <h2 className="text-[13px] font-semibold text-ink">Candidate vessels</h2>
            <p className="text-[11px] text-muted mt-0.5">Investigative leads ranked by compatibility.</p>
          </div>
          <button onClick={onOpenWeights} className="vn-btn" title="Adjust the four scoring factor weights">
            <Sliders className="w-3.5 h-3.5 text-navy-600" aria-hidden="true" />
            <span className="hidden sm:inline">Weights</span>
          </button>
        </div>

        <div className={`grid grid-cols-2 sm:grid-cols-3 gap-2 ${wide ? "max-w-3xl" : ""}`}>
          {[
            { label: "Scored", value: attribution.total_candidates, cls: "text-ink border-line" },
            { label: "High priority", value: attribution.high_priority_count, cls: "text-danger border-danger/25 bg-danger-50/60" },
            { label: "Medium", value: attribution.medium_priority_count, cls: "text-warn border-warn/25 bg-warn-50/60" },
          ].map((s) => (
            <div key={s.label} className={`rounded-[9px] border px-2.5 py-1.5 ${s.cls}`}>
              <div className="text-[18px] font-semibold vn-num leading-tight">{s.value}</div>
              <div className="text-[10px] font-medium text-muted uppercase tracking-wide leading-tight">{s.label}</div>
            </div>
          ))}
        </div>

        <div className="mt-2 text-[10.5px] text-muted leading-snug">
          {attribution.ais_data_source} · {attribution.ais_record_count} reports · gap #1→#2{" "}
          <span className="vn-num">{fmt(attribution.score_gap_top2 ?? null, 3)}</span>
        </div>
        {(attribution.coverage_warnings ?? []).length > 0 && (
          <Disclose summary={`${attribution.coverage_warnings!.length} coverage warning(s)`} className="mt-1.5">
            <ul className="space-y-1">
              {attribution.coverage_warnings!.map((w, i) => (
                <li key={i} className="text-[10.5px] text-warn leading-snug flex gap-1.5">
                  <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" aria-hidden="true" />
                  {w}
                </li>
              ))}
            </ul>
          </Disclose>
        )}
        <Disclose summary="How to read these numbers" className="mt-1.5" testId="score-legend">
          <ul className="space-y-1 text-[10.5px] text-muted leading-snug">
            <li>
              <b className="text-ink">Score / priority</b> — a heuristic compatibility score (weighted linear rule). Not a probability; not
              evidence of guilt.
            </li>
            <li>
              <b className="text-ink">Contributions</b> — exact Shapley values of that linear score. They explain the score; they are not learned.
            </li>
            <li>
              <b className="text-ink">Learned probabilities</b> — none exist. No attribution model is trained.
            </li>
            <li>
              <b className="text-ink">Investigator feedback</b> — recorded as unverified input, in memory only; it never changes a score.
            </li>
          </ul>
        </Disclose>
      </div>

      {/* Candidate cards */}
      <div className={`flex-1 overflow-y-auto p-3 ${wide ? "grid grid-cols-1 xl:grid-cols-2 gap-3 items-start content-start" : "space-y-2.5"}`}>
        {attribution.top_candidates.map((v) => {
          const isSelected = selectedVessel?.mmsi === v.mmsi;
          const isExpanded = expandedMmsi === v.mmsi;
          const p = priorityOf(v);
          const m = v.metrics;
          const q = v.ais_quality;
          const s = v.sensitivity;

          return (
            <article
              key={v.mmsi}
              data-testid="candidate-card"
              onClick={() => onSelectVessel(v)}
              className={`vn-card p-3.5 cursor-pointer transition-shadow hover:shadow-md ${
                isSelected ? "ring-2 ring-navy-600/40 border-navy-600/40" : ""
              }`}
              style={{ borderLeft: `3px solid ${p.accent}` }}
            >
              {/* Identity + score */}
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] text-muted vn-num">#{v.rank}</span>
                    <h3 className="text-[13.5px] font-semibold text-ink truncate">{v.vessel_name}</h3>
                  </div>
                  <div className="text-[11px] text-muted mt-0.5 vn-num truncate">
                    MMSI {v.mmsi} · {v.vessel_type}
                  </div>
                  <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
                    <Tag tone={p.tone}>{p.text}</Tag>
                    <span className="text-[10.5px] text-muted">Potential investigative lead</span>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-[20px] font-semibold vn-num leading-none" style={{ color: p.accent }}>
                    {v.composite_score.toFixed(3)}
                  </div>
                  <div className="text-[10px] text-muted mt-1">compatibility</div>
                </div>
              </div>

              {/* Headline metrics */}
              <div className="mt-3 grid grid-cols-3 gap-2 rounded-[9px] bg-subtle border border-line px-2.5 py-2">
                <div>
                  <div className="vn-label">To slick</div>
                  <div className="text-[12px] text-ink vn-num">{fmt(m.min_distance_to_slick_km ?? null, 1)} km</div>
                </div>
                <div>
                  <div className="vn-label">Δt vs SAR</div>
                  <div className="text-[12px] text-ink vn-num">
                    {m.time_delta_hours > 0 ? "+" : ""}
                    {fmt(m.time_delta_hours, 1)} h
                  </div>
                </div>
                <div>
                  <div className="vn-label">AIS coverage</div>
                  <Tag tone={qualityTone(q?.quality_label)}>{q?.quality_label ?? "n/a"}</Tag>
                </div>
              </div>

              {/* Evidence factors */}
              <div className="mt-3 space-y-1.5">
                <div className="vn-label">Evidence factors</div>
                {FACTORS.map((f) => {
                  const score = Number(v.feature_breakdown[f.score] ?? 0);
                  const w = v.feature_breakdown.weights_used[f.key];
                  const c = v.feature_breakdown.weighted_contributions?.[f.key];
                  return (
                    <div key={f.key}>
                      <div className="flex justify-between text-[11px] mb-0.5">
                        <span className="text-muted">
                          {f.label} <span className="text-faint">· w {(w * 100).toFixed(0)}%</span>
                        </span>
                        <span className="text-ink vn-num">
                          {(score * 100).toFixed(0)}%{c !== undefined ? <span className="text-muted"> → +{c.toFixed(3)}</span> : null}
                        </span>
                      </div>
                      <Meter value={score} color={f.color} />
                    </div>
                  );
                })}
              </div>

              {/* Actions */}
              <div className="mt-3 pt-2.5 border-t border-line flex items-center gap-2 flex-wrap">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setExpandedMmsi((prev) => (prev === v.mmsi ? null : v.mmsi));
                  }}
                  aria-expanded={isExpanded}
                  className="vn-btn"
                >
                  <Info className="w-3.5 h-3.5 text-navy-600" aria-hidden="true" />
                  {isExpanded ? "Hide evidence" : "View evidence"}
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectVessel(v);
                  }}
                  className="vn-btn"
                  title="Focus this vessel's AIS track on the map"
                >
                  <Crosshair className="w-3.5 h-3.5 text-navy-600" aria-hidden="true" />
                  View track
                </button>
                <span className="ml-auto text-[10.5px] text-muted vn-num">
                  {v.flag ? `${v.flag} · ` : ""}IMO {v.imo || "n/a"}
                </span>
              </div>

              {/* Evidence dossier */}
              {isExpanded && (
                <div className="mt-3 space-y-3" onClick={(e) => e.stopPropagation()}>
                  <div>
                    <div className="text-[12px] font-semibold text-ink mb-1.5">Why this vessel is a lead</div>
                    {(v.why_priority ?? []).length > 0 ? (
                      <ul className="space-y-1">
                        {v.why_priority!.map((x, i) => (
                          <li key={i} className="flex gap-1.5 text-[11.5px] text-ink-soft leading-snug">
                            <Check className="w-3.5 h-3.5 text-ok shrink-0 mt-px" aria-hidden="true" />
                            {x}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-[11.5px] text-muted italic">No supporting evidence item passed its threshold.</p>
                    )}
                  </div>

                  {(v.contradicting_evidence ?? []).length > 0 && (
                    <div>
                      <div className="text-[12px] font-semibold text-ink mb-1.5">Contradicting or limiting evidence</div>
                      <ul className="space-y-1">
                        {v.contradicting_evidence!.map((x, i) => (
                          <li key={i} className="flex gap-1.5 text-[11.5px] text-ink-soft leading-snug">
                            <X className="w-3.5 h-3.5 text-danger shrink-0 mt-px" aria-hidden="true" />
                            {x}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <Disclose summary="Technical measurements">
                    <div className="space-y-0">
                      <div className="vn-label mt-1">Spatial / temporal</div>
                      <KV k="Closest approach to slick" v={`${fmt(m.min_distance_to_slick_km ?? null, 2)} km @ ${utc(m.cpa_timestamp)}`} />
                      <KV k="…to slick centroid" v={`${fmt(m.min_distance_to_slick_centroid_km ?? null, 2)} km`} />
                      <KV k="Position at closest approach" v={fmtLatLon(m.cpa_coordinates, 3)} />

                      <div className="vn-label mt-2">Trajectory vs backtracked corridor</div>
                      <KV k="Enters P90 corridor" v={m.intersects_origin ? "yes" : "no"} />
                      <KV
                        k="Min distance to corridor centre"
                        v={
                          m.corridor_min_distance_km == null
                            ? "no positions in window"
                            : `${fmt(m.corridor_min_distance_km, 2)} km (P90 r ${fmt(m.corridor_r90_at_best_km ?? null, 2)} km)`
                        }
                      />
                      <KV k="At" v={utc(m.corridor_best_time ?? null)} />

                      <div className="vn-label mt-2">Kinematics</div>
                      <KV k="SOG / COG at closest approach" v={`${fmt(m.cpa_speed_knots, 1)} kn / ${m.cpa_course_deg == null ? "n/a" : fmt(m.cpa_course_deg, 0) + "°"}`} />
                      <KV k="Course vs slick axis" v={m.course_slick_axis_difference_deg == null ? "n/a" : `${fmt(m.course_slick_axis_difference_deg, 0)}°`} />

                      <div className="vn-label mt-2">Vessel metadata (AIS static)</div>
                      <KV k="Type" v={v.vessel_type} />
                      <KV k="Dimensions" v={`${v.length_m ? v.length_m + " m" : "n/a"} × ${v.width_m ? v.width_m + " m" : "n/a"}`} />

                      {q && (
                        <>
                          <div className="vn-label mt-2">AIS data quality</div>
                          <KV k="Reports (in backtrack window)" v={`${q.n_points} (${q.n_points_in_window})`} />
                          <KV k="Window coverage / max gap" v={`${Math.round(q.window_coverage_fraction * 100)} % / ${fmt(q.max_gap_in_window_min, 0)} min`} />
                          <KV k="Median interval / speed outliers" v={`${fmt(q.median_interval_min, 1)} min / ${q.implied_speed_outliers}`} />
                        </>
                      )}

                      {s && (
                        <>
                          <div className="vn-label mt-2">Rank sensitivity (leave one factor out)</div>
                          <KV k="Rank range" v={`${s.rank_min}–${s.rank_max} ${s.stable ? "(stable)" : "(unstable)"}`} />
                          <KV
                            k="w/o spatial · temporal · corridor · kinematic"
                            v={`${s.rank_without_spatial} · ${s.rank_without_temporal} · ${s.rank_without_trajectory} · ${s.rank_without_kinematic}`}
                          />
                        </>
                      )}

                      {v.baseline_offline_score != null && <KV k="2018 offline baseline score" v={v.baseline_offline_score.toFixed(3)} />}

                      {v.explanation && (
                        <>
                          <div className="vn-label mt-2">Exact Shapley contributions (vs mean vessel {v.explanation.base_value.toFixed(3)})</div>
                          {(["spatial", "temporal", "trajectory", "consistency"] as const).map((k) => (
                            <KV
                              key={k}
                              k={k === "trajectory" ? "corridor" : k === "consistency" ? "kinematic" : k}
                              v={
                                <span className={v.explanation!.contributions[k] >= 0 ? "text-navy-600" : "text-warn"}>
                                  {v.explanation!.contributions[k] >= 0 ? "+" : ""}
                                  {v.explanation!.contributions[k].toFixed(3)}
                                </span>
                              }
                            />
                          ))}
                        </>
                      )}

                      {attribution.environmental_consistency && (
                        <>
                          <div className="vn-label mt-2">Scene-level environment</div>
                          <KV
                            k="Wind vs slick axis"
                            v={`${fmt(attribution.environmental_consistency.wind_slick_difference_deg, 0)}° (drift compatibility is the corridor factor)`}
                          />
                        </>
                      )}
                    </div>
                  </Disclose>

                  {onCounterfactual && (
                    <button
                      data-testid="cf-exclude"
                      disabled={counterfactualBusy}
                      onClick={() => onCounterfactual(v.mmsi)}
                      className="vn-btn w-full justify-center"
                    >
                      <FlaskConical className="w-3.5 h-3.5 text-navy-600" aria-hidden="true" />
                      Counterfactual: exclude this vessel and re-rank
                    </button>
                  )}

                  <p className="text-[10.5px] text-muted italic leading-relaxed rounded-[8px] bg-subtle border border-line p-2">
                    {v.scientific_disclaimer}
                  </p>
                </div>
              )}
            </article>
          );
        })}
      </div>

      {/* Standing notice */}
      <div className="px-4 py-2.5 border-t border-line bg-surface shrink-0 flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 text-warn shrink-0 mt-px" aria-hidden="true" />
        <p className="text-[10.5px] text-muted leading-snug">
          <b className="text-ink-soft">Decision support only.</b> Scores rank investigative leads by compatibility with the observed slick and a
          modelled drift corridor. They are not probabilities of guilt and not legal attribution; verification requires physical sampling and
          vessel records.
        </p>
      </div>
    </div>
  );
};
