import React from "react";
import { FlaskConical, RefreshCw, AlertTriangle } from "lucide-react";
import { fmt } from "../lib/format";

interface Props {
  results: any[];
  busy: boolean;
  canRun: boolean;
  onRunSensitivity: () => void;
}

/** Counterfactual results: ANALYTICAL SCENARIOS computed by the server engines. */
export const CounterfactualPanel: React.FC<Props> = ({ results, busy, canRun, onRunSensitivity }) => (
  <div className="h-full overflow-y-auto p-2 text-[10px] space-y-2">
    <div className="flex items-center justify-between">
      <div className="text-muted flex items-center gap-1.5"><FlaskConical className="w-3.5 h-3.5 text-teal" />
        Counterfactuals are analytical scenarios computed with the same engines - not observations or historical facts. Exclude a vessel from its dossier, or test forcing sensitivity here.</div>
      <button data-testid="cf-sensitivity" onClick={onRunSensitivity} disabled={!canRun || busy}
        className="shrink-0 ml-2 px-2 py-1 rounded-[3px] border border-teal/40 text-teal font-mono cursor-pointer disabled:opacity-40 flex items-center gap-1">
        {busy ? <RefreshCw className="w-3 h-3 animate-spin" /> : null} Run forcing sensitivity
      </button>
    </div>
    {!results.length && <div className="text-muted italic p-4 text-center">No counterfactual run yet.</div>}
    {results.map((r, i) => (
      <div key={i} data-testid={`cf-result-${r.kind}`} className="bg-surface border border-teal/30 rounded p-2 space-y-1.5">
        <div className="font-mono text-[9px] text-teal">{r.label}</div>
        <div className="font-semibold text-ink">{r.question}</div>
        {r.kind === "exclude_vessel" && (
          <>
            <div className="text-ink">Top candidate {r.top_candidate_changed ? <b className="text-warn">changes</b> : "unchanged"} · gap #1→#2 {fmt(r.score_gap_top2_before, 3)} → {fmt(r.score_gap_top2_after, 3)}</div>
            <div className="grid grid-cols-2 gap-2 font-mono text-[9px]">
              <div><div className="text-muted">Before</div>{r.top_before.map((c: any) => <div key={c.mmsi}>#{c.rank} {c.vessel_name} {fmt(c.score, 3)}</div>)}</div>
              <div><div className="text-muted">After excluding {r.excluded.vessel_name}</div>{r.top_after.map((c: any) => <div key={c.mmsi}>#{c.rank} {c.vessel_name} {fmt(c.score, 3)}</div>)}</div>
            </div>
            <table className="w-full font-mono text-[9px]"><tbody>
              {r.hypotheses.map((h: any) => (
                <tr key={h.id} className="border-t border-line"><td className="text-ink pr-2">{h.id} {h.title}</td>
                  <td className="text-muted">balance {h.balance_before ?? "n/a"} → {h.balance_after ?? "n/a"}</td><td className="text-muted">{h.strength_before} → {h.strength_after}</td></tr>
              ))}
            </tbody></table>
            <div className="text-[9px] text-muted italic">{r.note}</div>
          </>
        )}
        {r.kind === "forcing_sensitivity" && (
          <>
            <div className={r.conclusion_stable ? "text-ok" : "text-warn"}>
              {r.conclusion_stable ? "Top candidate identical in every forcing scenario" : <span className="flex items-center gap-1"><AlertTriangle className="w-3 h-3" />Top candidate depends on the forcing assumptions</span>}
            </div>
            <table className="w-full font-mono text-[9px]">
              <thead><tr className="text-muted text-left"><th>Scenario</th><th>Origin shift</th><th>Origin P90</th><th>Top candidate</th><th>Top-3 overlap</th></tr></thead>
              <tbody>{r.scenarios.map((s: any) => (
                <tr key={s.scenario} className="border-t border-line"><td className="text-ink pr-1">{s.label}</td><td>{fmt(s.origin_shift_km, 2)} km</td><td>{fmt(s.origin_r90_km, 1)} km</td>
                  <td className={s.top_candidate_same_as_run ? "text-ink" : "text-warn"}>{s.top_candidate ? `${s.top_candidate.vessel_name} ${fmt(s.top_candidate.score, 3)}` : "none"}</td><td>{s.top3_overlap_with_run}/3</td></tr>
              ))}</tbody>
            </table>
            <div className="text-[9px] text-muted italic">{r.note}</div>
          </>
        )}
      </div>
    ))}
  </div>
);
