import React, { useState } from "react";
import { Ship, ChevronDown, ChevronUp, AlertCircle, Info, CheckCircle2, XCircle } from "lucide-react";
import type { CandidateRanking, VesselScoreDetail } from "../types";
import { fmt, fmtLatLon, utc } from "../lib/format";

interface CandidatePanelProps {
  attribution: CandidateRanking | null;
  selectedVessel: VesselScoreDetail | null;
  onSelectVessel: (vessel: VesselScoreDetail | null) => void;
  onOpenWeights: () => void;
  onCounterfactual?: (mmsi: string) => void;
  counterfactualBusy?: boolean;
}

const FACTORS: { key: "spatial" | "temporal" | "trajectory" | "consistency"; label: string; score: keyof VesselScoreDetail["feature_breakdown"]; color: string }[] = [
  { key: "spatial", label: "Spatial", score: "spatial_proximity_score", color: "#58A6FF" },
  { key: "temporal", label: "Temporal", score: "temporal_alignment_score", color: "#79C0FF" },
  { key: "trajectory", label: "Corridor", score: "trajectory_intersection_score", color: "#bc8cff" },
  { key: "consistency", label: "Kinematic", score: "kinematic_consistency_score", color: "#AFF5B4" },
];

const Row: React.FC<{ k: string; v: React.ReactNode }> = ({ k, v }) => (
  <div className="flex justify-between gap-2"><span className="text-[#8B949E]">{k}</span><span className="text-[#C9D1D9] text-right">{v}</span></div>
);

export const CandidatePanel: React.FC<CandidatePanelProps> = ({ attribution, selectedVessel, onSelectVessel, onOpenWeights, onCounterfactual, counterfactualBusy }) => {
  const [expandedMmsi, setExpandedMmsi] = useState<string | null>(null);
  if (!attribution) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-6 text-center text-[#8B949E] bg-[#0D1117]">
        <Ship className="w-10 h-10 text-[#30363D] mb-3 animate-pulse" />
        <h3 className="text-xs font-semibold text-[#C9D1D9] mb-1">Awaiting Candidate Scoring</h3>
        <p className="text-[11px] max-w-xs text-[#8B949E]">Run the investigation to score AIS tracks against the observed slick and the backtracked origin corridor.</p>
      </div>
    );
  }
  const toggle = (mmsi: string, e: React.MouseEvent) => { e.stopPropagation(); setExpandedMmsi((p) => (p === mmsi ? null : mmsi)); };

  return (
    <div className="h-full flex flex-col bg-[#0D1117] overflow-hidden select-none">
      <div className="p-3.5 border-b border-[#30363D] bg-[#161B22] shrink-0">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2"><Ship className="w-3.5 h-3.5 text-[#58A6FF]" /><h2 className="text-[11px] font-bold text-[#8B949E] uppercase tracking-wider">Candidate Vessels</h2></div>
          <button onClick={onOpenWeights} className="text-[10px] text-[#58A6FF] hover:text-[#79C0FF] font-mono cursor-pointer">[Weights]</button>
        </div>
        <div className="grid grid-cols-3 gap-1.5 text-center">
          <div className="bg-[#0D1117] border border-[#30363D] rounded-[4px] p-1.5"><div className="text-[9px] text-[#8B949E] uppercase">Scored</div><div className="text-xs font-mono font-bold text-[#C9D1D9]">{attribution.total_candidates}</div></div>
          <div className="bg-[#FF4444]/10 border border-[#FF4444]/30 rounded-[4px] p-1.5"><div className="text-[9px] text-[#FF4444] uppercase">High Priority</div><div className="text-xs font-mono font-bold text-[#FF4444]">{attribution.high_priority_count}</div></div>
          <div className="bg-[#d29922]/10 border border-[#d29922]/30 rounded-[4px] p-1.5"><div className="text-[9px] text-[#d29922] uppercase">Medium</div><div className="text-xs font-mono font-bold text-[#d29922]">{attribution.medium_priority_count}</div></div>
        </div>
        <div className="mt-2 text-[9px] font-mono text-[#8B949E] space-y-0.5">
          <div>{attribution.ais_data_source} · {attribution.ais_record_count} reports · gap #1→#2 {fmt(attribution.score_gap_top2 ?? null, 3)}</div>
          {(attribution.coverage_warnings ?? []).map((w, i) => <div key={i} className="text-[#d29922]">⚠ {w}</div>)}
        </div>
        <details className="mt-2 text-[9px] font-mono text-[#8B949E]" data-testid="score-legend">
          <summary className="cursor-pointer text-[#58A6FF] hover:text-[#79C0FF]" title="What kind of number is each figure?">How to read these numbers</summary>
          <ul className="mt-1 space-y-1 leading-snug">
            <li><b className="text-[#C9D1D9]">Score / priority</b>: a HEURISTIC compatibility score (weighted linear rule). Not a probability; not evidence of guilt.</li>
            <li><b className="text-[#C9D1D9]">Contributions (+0.313 …)</b>: MATHEMATICAL exact Shapley values of that linear score. They explain the score; they are not learned.</li>
            <li><b className="text-[#C9D1D9]">Learned probabilities</b>: none exist. No attribution model is trained (no labelled confirmed-polluter data).</li>
            <li><b className="text-[#C9D1D9]">Investigator feedback</b>: recorded as UNVERIFIED input, in memory only; it never changes a score.</li>
            <li>Candidates are investigative leads. Causation is NOT CONFIRMED.</li>
          </ul>
        </details>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
        {attribution.top_candidates.map((v) => {
          const isSelected = selectedVessel?.mmsi === v.mmsi;
          const isExpanded = expandedMmsi === v.mmsi || isSelected;
          const isHigh = v.priority_level === "HIGH PRIORITY CANDIDATE";
          const isMed = v.priority_level === "MEDIUM PRIORITY CANDIDATE";
          const cardBorder = isSelected ? "border-[#AFF5B4] bg-[#161B22] ring-1 ring-[#AFF5B4]/30"
            : isHigh ? "border-[#FF4444]/40 bg-[#161B22] hover:border-[#FF4444]/70"
            : isMed ? "border-[#d29922]/40 bg-[#161B22] hover:border-[#d29922]/70" : "border-[#30363D] bg-[#161B22] hover:border-[#8B949E]";
          const m = v.metrics;
          const q = v.ais_quality;
          const s = v.sensitivity;
          return (
            <div key={v.mmsi} data-testid="candidate-card" onClick={() => onSelectVessel(v)} className={`rounded-[6px] border transition-all cursor-pointer p-3 ${cardBorder}`}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-xs font-bold text-[#C9D1D9] leading-tight flex items-center gap-1.5"><span className="font-mono text-[10px] text-[#8B949E]">#{v.rank}</span><span>{v.vessel_name}</span></div>
                  <div className="text-[10px] text-[#8B949E] font-mono mt-0.5">MMSI {v.mmsi} • {v.vessel_type}</div>
                </div>
                <div className="text-right shrink-0">
                  <div className={`font-mono text-[14px] font-bold ${isSelected ? "text-[#AFF5B4]" : isHigh ? "text-[#FF4444]" : isMed ? "text-[#d29922]" : "text-[#8B949E]"}`}>{v.composite_score.toFixed(3)}</div>
                  <span className={`text-[8px] uppercase font-mono px-1 py-0.5 rounded-[2px] tracking-wider ${isHigh ? "bg-[#FF4444]/10 text-[#FF4444] border border-[#FF4444]/30" : isMed ? "bg-[#d29922]/10 text-[#d29922] border border-[#d29922]/30" : "bg-[#21262D] text-[#8B949E]"}`}>{isHigh ? "HIGH" : isMed ? "MED" : "LOW"}</span>
                </div>
              </div>

              <div className="mt-2 grid grid-cols-3 gap-1 text-[10px] bg-[#0D1117] border border-[#30363D] rounded-[4px] p-1.5 font-mono">
                <div><span className="text-[#8B949E] block text-[8px] uppercase">To slick</span><span className="text-[#C9D1D9]">{fmt(m.min_distance_to_slick_km ?? null, 1)} km</span></div>
                <div><span className="text-[#8B949E] block text-[8px] uppercase">Δt vs SAR</span><span className="text-[#C9D1D9]">{m.time_delta_hours > 0 ? "+" : ""}{fmt(m.time_delta_hours, 1)} h</span></div>
                <div><span className="text-[#8B949E] block text-[8px] uppercase">AIS</span><span className={q?.quality_label === "GOOD" ? "text-[#3fb950]" : q?.quality_label === "FAIR" ? "text-[#d29922]" : "text-[#f85149]"}>{q?.quality_label ?? "n/a"}</span></div>
              </div>

              <div className="mt-2.5 space-y-1 text-[10px]">
                {FACTORS.map((f) => {
                  const score = Number(v.feature_breakdown[f.score] ?? 0);
                  const w = v.feature_breakdown.weights_used[f.key];
                  const c = v.feature_breakdown.weighted_contributions?.[f.key];
                  return (
                    <div key={f.key}>
                      <div className="flex justify-between text-[#8B949E] mb-0.5 text-[9px] font-mono">
                        <span>{f.label} (w {(w * 100).toFixed(0)}%)</span>
                        <span className="text-[#C9D1D9]">{score.toFixed(2)}{c !== undefined ? ` → +${c.toFixed(3)}` : ""}</span>
                      </div>
                      <div className="w-full h-1 bg-[#0D1117] rounded-full overflow-hidden border border-[#30363D]"><div className="h-full rounded-full" style={{ width: `${score * 100}%`, background: f.color }} /></div>
                    </div>
                  );
                })}
              </div>

              <div className="mt-2 pt-2 border-t border-[#30363D] flex items-center justify-between">
                <button onClick={(e) => toggle(v.mmsi, e)} className="text-[10px] text-[#58A6FF] hover:text-[#79C0FF] flex items-center gap-1 font-mono cursor-pointer">
                  {isExpanded ? <><ChevronUp className="w-3 h-3" /> [Hide dossier]</> : <><ChevronDown className="w-3 h-3" /> [Evidence dossier]</>}
                </button>
                <span className="text-[9px] text-[#8B949E] font-mono">{v.flag ? `Flag ${v.flag} · ` : ""}IMO {v.imo || "n/a"}</span>
              </div>

              {isExpanded && (
                <div className="mt-2 space-y-2 text-[10px] bg-[#0D1117] p-2 rounded-[4px] border border-[#30363D]" onClick={(e) => e.stopPropagation()}>
                  <div className="font-semibold text-[#C9D1D9] flex items-center gap-1"><Info className="w-3 h-3 text-[#58A6FF]" />Why is this vessel a priority candidate?</div>
                  {(v.why_priority ?? []).length > 0
                    ? <ul className="space-y-0.5">{v.why_priority!.map((x, i) => <li key={i} className="flex gap-1 text-[#C9D1D9]"><CheckCircle2 className="w-3 h-3 text-[#3fb950] shrink-0 mt-0.5" />{x}</li>)}</ul>
                    : <div className="text-[#8B949E] italic">No supporting evidence item passed its threshold.</div>}
                  {(v.contradicting_evidence ?? []).length > 0 && (
                    <>
                      <div className="font-semibold text-[#C9D1D9]">Contradicting / limiting evidence</div>
                      <ul className="space-y-0.5">{v.contradicting_evidence!.map((x, i) => <li key={i} className="flex gap-1 text-[#C9D1D9]"><XCircle className="w-3 h-3 text-[#f85149] shrink-0 mt-0.5" />{x}</li>)}</ul>
                    </>
                  )}
                  <div className="grid grid-cols-1 gap-0.5 font-mono text-[9px] border-t border-[#30363D] pt-1.5">
                    <div className="text-[#8B949E] uppercase text-[8px]">Spatial / temporal</div>
                    <Row k="Closest approach to slick" v={`${fmt(m.min_distance_to_slick_km ?? null, 2)} km @ ${utc(m.cpa_timestamp)}`} />
                    <Row k="…to slick centroid" v={`${fmt(m.min_distance_to_slick_centroid_km ?? null, 2)} km`} />
                    <Row k="CPA position" v={fmtLatLon(m.cpa_coordinates, 3)} />
                    <div className="text-[#8B949E] uppercase text-[8px] mt-1">Trajectory vs backtracked corridor</div>
                    <Row k="Enters P90 corridor" v={m.intersects_origin ? "yes" : "no"} />
                    <Row k="Min distance to corridor centre" v={m.corridor_min_distance_km == null ? "no positions in window" : `${fmt(m.corridor_min_distance_km, 2)} km (P90 r ${fmt(m.corridor_r90_at_best_km ?? null, 2)} km)`} />
                    <Row k="At" v={utc(m.corridor_best_time ?? null)} />
                    <div className="text-[#8B949E] uppercase text-[8px] mt-1">Kinematics</div>
                    <Row k="SOG / COG at CPA" v={`${fmt(m.cpa_speed_knots, 1)} kn / ${m.cpa_course_deg == null ? "n/a" : fmt(m.cpa_course_deg, 0) + "°"}`} />
                    <Row k="Course vs slick axis" v={m.course_slick_axis_difference_deg == null ? "n/a" : `${fmt(m.course_slick_axis_difference_deg, 0)}°`} />
                    <div className="text-[#8B949E] uppercase text-[8px] mt-1">Vessel metadata (AIS static)</div>
                    <Row k="Type" v={v.vessel_type} />
                    <Row k="Dimensions" v={`${v.length_m ? v.length_m + " m" : "n/a"} × ${v.width_m ? v.width_m + " m" : "n/a"}`} />
                    {q && (<>
                      <div className="text-[#8B949E] uppercase text-[8px] mt-1">AIS data quality</div>
                      <Row k="Reports (in backtrack window)" v={`${q.n_points} (${q.n_points_in_window})`} />
                      <Row k="Coverage of window / max gap" v={`${Math.round(q.window_coverage_fraction * 100)} % / ${fmt(q.max_gap_in_window_min, 0)} min`} />
                      <Row k="Median interval / speed outliers" v={`${fmt(q.median_interval_min, 1)} min / ${q.implied_speed_outliers}`} />
                    </>)}
                    {s && (<>
                      <div className="text-[#8B949E] uppercase text-[8px] mt-1">Rank sensitivity (leave one factor out)</div>
                      <Row k="Rank range" v={`${s.rank_min}–${s.rank_max} ${s.stable ? "(stable)" : "(unstable)"}`} />
                      <Row k="w/o spatial · temporal · corridor · kinematic" v={`${s.rank_without_spatial} · ${s.rank_without_temporal} · ${s.rank_without_trajectory} · ${s.rank_without_kinematic}`} />
                    </>)}
                    {v.baseline_offline_score != null && <Row k="2018 offline baseline score" v={v.baseline_offline_score.toFixed(3)} />}
                  </div>
                  {v.explanation && (
                    <div className="font-mono text-[9px] border-t border-[#30363D] pt-1.5">
                      <div className="text-[#8B949E] uppercase text-[8px]">Exact Shapley contributions (vs mean vessel {v.explanation.base_value.toFixed(3)})</div>
                      {(["spatial", "temporal", "trajectory", "consistency"] as const).map((k) => (
                        <Row key={k} k={k === "trajectory" ? "corridor" : k === "consistency" ? "kinematic" : k} v={<span className={v.explanation!.contributions[k] >= 0 ? "text-[#58A6FF]" : "text-[#d29922]"}>{v.explanation!.contributions[k] >= 0 ? "+" : ""}{v.explanation!.contributions[k].toFixed(3)}</span>} />
                      ))}
                    </div>
                  )}
                  {attribution.environmental_consistency && (
                    <div className="font-mono text-[9px]">
                      <Row k="Environmental consistency (scene)" v={`wind vs slick axis ${fmt(attribution.environmental_consistency.wind_slick_difference_deg, 0)}°; drift compatibility is the corridor factor`} />
                    </div>
                  )}
                  {onCounterfactual && (
                    <button data-testid="cf-exclude" disabled={counterfactualBusy} onClick={() => onCounterfactual(v.mmsi)}
                      className="w-full text-[9px] font-mono py-1 rounded-[3px] border border-[#bc8cff]/50 text-[#bc8cff] hover:bg-[#bc8cff]/10 cursor-pointer disabled:opacity-40">
                      Counterfactual: exclude this vessel and re-rank
                    </button>
                  )}
                  <div className="p-1.5 rounded-[3px] bg-[#161B22] border border-[#30363D] text-[9px] text-[#8B949E] italic">{v.scientific_disclaimer}</div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="p-3 border-t border-[#30363D] bg-[#161B22] text-[10px] text-[#8B949E] shrink-0 flex items-start gap-2">
        <AlertCircle className="w-4 h-4 text-[#d29922] shrink-0 mt-0.5" />
        <div className="leading-tight text-[9px]"><b>Decision-support notice:</b> scores rank investigative leads by compatibility with the observed slick and a modelled drift corridor. They are not probabilities of guilt and not legal attribution; verification requires physical sampling and records.</div>
      </div>
    </div>
  );
};
