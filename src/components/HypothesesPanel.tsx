import React from "react";
import type { InvestigationView } from "../types";
import { levelColor } from "../lib/format";

export const HypothesesPanel: React.FC<{ investigation: InvestigationView | null }> = ({ investigation }) => {
  const s = investigation?.state;
  if (!s?.hypotheses) {
    return <div className="h-full flex items-center justify-center text-[11px] text-muted font-mono">Hypotheses appear after the investigation completes.</div>;
  }
  return (
    <div className="h-full overflow-y-auto p-2 text-[10px]">
      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-4 gap-2">
        {s.hypotheses.map((h) => (
          <div key={h.id} className="bg-surface border border-line rounded p-2 space-y-1">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-ink text-[11px]">{h.id} · {h.title}</span>
            </div>
            <div className="text-muted">{h.statement}</div>
            <div className="flex gap-2 font-mono text-[9px]">
              <span style={{ color: levelColor(h.evidence_strength) }}>SUPPORT {h.evidence_strength}</span>
              <span style={{ color: levelColor(h.uncertainty) }}>UNCERTAINTY {h.uncertainty}</span>
            </div>
            <div title="Supporting strength / (supporting + contradicting). Heuristic, not a probability.">
              <div className="flex justify-between text-[9px] text-muted"><span>evidence balance</span><span>{h.evidence_balance === null ? "no evidence" : h.evidence_balance.toFixed(2)}</span></div>
              <div className="h-1.5 bg-danger/20 rounded-full overflow-hidden"><div className="h-full bg-ok" style={{ width: `${(h.evidence_balance ?? 0) * 100}%` }} /></div>
            </div>
            {h.supporting.length > 0 && <ul className="space-y-0.5">{h.supporting.map((e, i) => <li key={i} className="text-ok">+{"●".repeat(e.strength)} <span className="text-ink">{e.text}</span></li>)}</ul>}
            {h.contradicting.length > 0 && <ul className="space-y-0.5">{h.contradicting.map((e, i) => <li key={i} className="text-danger">−{"●".repeat(e.strength)} <span className="text-ink">{e.text}</span></li>)}</ul>}
            <div className="text-[9px] text-muted">Missing: {h.missing_evidence.join("; ")}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-2 mt-2">
        {s.uncertainty && (
          <div className="bg-surface border border-line rounded p-2">
            <div className="font-semibold text-ink mb-1">Uncertainty (separate from scores) — overall <span style={{ color: levelColor(s.uncertainty.overall) }}>{s.uncertainty.overall}</span></div>
            <table className="w-full"><tbody>
              {s.uncertainty.components.map((c) => (
                <tr key={c.component} className="border-t border-line align-top">
                  <td className="py-0.5 pr-2 text-ink whitespace-nowrap">{c.component}</td>
                  <td className="py-0.5 pr-2 font-mono" style={{ color: levelColor(c.level) }}>{c.level}</td>
                  <td className="py-0.5 text-muted">{c.basis}</td>
                </tr>
              ))}
            </tbody></table>
            <div className="text-[9px] text-muted mt-1">{s.uncertainty.note}</div>
          </div>
        )}
        {s.risk && (
          <div className="bg-surface border border-line rounded p-2">
            <div className="font-semibold text-ink mb-1">Risk assessment — <span style={{ color: s.risk.color }}>{s.risk.level}</span></div>
            {s.risk.factors.map((f) => (
              <div key={f.name} className="flex justify-between border-t border-line py-0.5"><span className="text-muted">{f.name}</span><span className="text-ink">{f.value} · {f.category}</span></div>
            ))}
            <div className="text-[9px] text-muted mt-1">{s.risk.method}</div>
          </div>
        )}
        {s.recommendations && (
          <div className="bg-surface border border-line rounded p-2">
            <div className="font-semibold text-ink mb-1">Recommended response</div>
            <ul className="space-y-1">
              {s.recommendations.map((r, i) => (
                <li key={i}>
                  <span className={`font-mono text-[9px] px-1 rounded mr-1 ${r.priority === "IMMEDIATE" ? "bg-danger-50 text-danger" : r.priority === "HIGH" ? "bg-warn-50 text-warn" : "bg-subtle text-muted"}`}>{r.priority}</span>
                  <span className="text-ink">{r.action}</span>
                  <div className="text-[9px] text-muted ml-1">{r.rationale}</div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {s.evidence_graph && (
        <div className="bg-surface border border-line rounded p-2 mt-2">
          <div className="font-semibold text-ink mb-1">Evidence graph — {s.evidence_graph.nodes.length} nodes, {s.evidence_graph.edges.length} edges</div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-x-4 font-mono text-[9px]">
            {s.evidence_graph.edges.map((e, i) => {
              const a = s.evidence_graph!.nodes.find((n) => n.id === e.from);
              const b = s.evidence_graph!.nodes.find((n) => n.id === e.to);
              return <div key={i} className="truncate text-muted"><span className="text-ink">{a?.label ?? e.from}</span> —{e.rel}→ <span className="text-ink">{b?.label ?? e.to}</span></div>;
            })}
          </div>
        </div>
      )}
    </div>
  );
};
