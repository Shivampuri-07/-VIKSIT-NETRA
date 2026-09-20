import React, { useState } from "react";
import { Search, Check, X, Ship, MapPin, Info } from "lucide-react";
import type { InvestigationView, VesselScoreDetail } from "../types";
import { searchEvidence, type EvidenceAnswer } from "../../server/lib/evidence_search";
import { Tag, EmptyState } from "./ui";

interface Props {
  investigation: InvestigationView | null;
  /** Select a vessel and reveal it on the map. */
  onShowVessel?: (mmsi: string) => void;
}

const EXAMPLES = [
  "Which vessels have the strongest evidence?",
  "Which vessels were closest to the spill origin?",
  "Show the AIS evidence",
  "What evidence is missing?",
];

const toneClass: Record<string, string> = {
  ok: "text-ok",
  warn: "text-warn",
  danger: "text-danger",
  neutral: "text-ink",
};

/**
 * Deterministic query over the investigation state that is already loaded.
 * server/lib/evidence_search.ts is a pure lookup layer: no language model, and no value that the
 * investigation engines did not already compute.
 */
export const EvidenceSearch: React.FC<Props> = ({ investigation, onShowVessel }) => {
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState<EvidenceAnswer | null>(null);

  const run = (q: string) => {
    setQuery(q);
    setAnswer(searchEvidence(investigation?.state ?? null, q));
  };

  return (
    <div className="p-4 space-y-3">
      <form
        onSubmit={(e) => { e.preventDefault(); run(query); }}
        className="flex flex-col sm:flex-row gap-2"
        role="search"
      >
        <label className="sr-only" htmlFor="evidence-q">Ask about this investigation</label>
        <input
          id="evidence-q"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Which vessels have the strongest evidence?"
          className="flex-1 min-w-0 border border-line-strong rounded-[9px] px-3 py-2 text-[13px] text-ink bg-surface placeholder:text-faint"
          data-testid="evidence-query"
        />
        <button type="submit" className="vn-btn vn-btn-primary shrink-0" disabled={!investigation}>
          <Search className="w-4 h-4" aria-hidden="true" />
          Search
        </button>
      </form>

      <div className="flex flex-wrap gap-1.5">
        {EXAMPLES.map((e) => (
          <button key={e} onClick={() => run(e)} disabled={!investigation} className="vn-btn !py-1 !text-[11px] disabled:opacity-50">
            {e}
          </button>
        ))}
      </div>

      {!investigation && (
        <EmptyState icon={Search} title="No investigation loaded" hint="Run an investigation, then query its evidence here." />
      )}

      {answer && investigation && (
        <div className="space-y-3" data-testid="evidence-answer">
          <div className="flex items-start justify-between gap-3 border-t border-line pt-3">
            <div>
              <h4 className="text-[13px] font-semibold text-ink">{answer.headline}</h4>
              <p className="text-[11px] text-muted mt-0.5">Matched intent: {answer.intent.replace(/_/g, " ")}</p>
            </div>
            <Tag tone="info">{answer.hits.length} result{answer.hits.length === 1 ? "" : "s"}</Tag>
          </div>

          {answer.suggestions && (
            <ul className="text-[11.5px] text-muted space-y-1">
              {answer.suggestions.map((s) => (
                <li key={s}>
                  <button onClick={() => run(s)} className="text-navy-600 hover:underline cursor-pointer">{s}</button>
                </li>
              ))}
            </ul>
          )}

          {answer.hits.map((h, i) => (
            <article key={i} className="rounded-[10px] border border-line bg-surface p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h5 className="text-[13px] font-semibold text-ink flex items-center gap-1.5">
                    {h.kind === "vessel" ? <Ship className="w-3.5 h-3.5 text-navy-600" aria-hidden="true" /> : <Info className="w-3.5 h-3.5 text-navy-600" aria-hidden="true" />}
                    {h.title}
                  </h5>
                  {h.subtitle && <p className="text-[11px] text-muted mt-0.5">{h.subtitle}</p>}
                </div>
                {h.score !== undefined && (
                  <div className="text-right shrink-0">
                    <div className="text-[16px] font-semibold vn-num text-ink leading-none">{h.score.toFixed(3)}</div>
                    {h.priority && <div className="text-[10px] text-muted mt-1">{h.priority.replace(" CANDIDATE", "")}</div>}
                  </div>
                )}
              </div>

              {h.supporting.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {h.supporting.map((s, k) => (
                    <li key={k} className="flex gap-1.5 text-[11.5px] text-ink-soft leading-snug">
                      <Check className="w-3.5 h-3.5 text-ok shrink-0 mt-px" aria-hidden="true" />{s}
                    </li>
                  ))}
                </ul>
              )}
              {h.contradicting.length > 0 && (
                <ul className="mt-1.5 space-y-1">
                  {h.contradicting.map((s, k) => (
                    <li key={k} className="flex gap-1.5 text-[11.5px] text-ink-soft leading-snug">
                      <X className="w-3.5 h-3.5 text-danger shrink-0 mt-px" aria-hidden="true" />{s}
                    </li>
                  ))}
                </ul>
              )}

              {h.facts.length > 0 && (
                <dl className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-4">
                  {h.facts.map((f, k) => (
                    <div key={k} className="flex justify-between gap-2 py-[3px] border-b border-line last:border-0">
                      <dt className="text-[11px] text-muted shrink-0">{f.label}</dt>
                      <dd className={`text-[11px] text-right vn-num ${toneClass[f.tone ?? "neutral"]}`}>{f.value}</dd>
                    </div>
                  ))}
                </dl>
              )}

              {h.kind === "vessel" && h.mmsi && onShowVessel && (
                <button onClick={() => onShowVessel(h.mmsi!)} className="vn-btn mt-2.5">
                  <MapPin className="w-3.5 h-3.5 text-navy-600" aria-hidden="true" />
                  Show on map
                </button>
              )}
            </article>
          ))}

          {answer.notes.length > 0 && (
            <ul className="space-y-1">
              {answer.notes.map((nt, i) => (
                <li key={i} className="text-[11px] text-warn leading-snug">⚠ {nt}</li>
              ))}
            </ul>
          )}

          <p className="text-[10.5px] text-muted leading-relaxed border-t border-line pt-2">{answer.disclaimer}</p>
        </div>
      )}
    </div>
  );
};

/** Helper for the parent: map an MMSI back to the candidate object it already holds. */
export function findCandidate(list: VesselScoreDetail[] | undefined, mmsi: string): VesselScoreDetail | null {
  return (list ?? []).find((c) => c.mmsi === mmsi) ?? null;
}
