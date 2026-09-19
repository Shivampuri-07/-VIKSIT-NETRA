/**
 * Investigator review priority (active-learning queue signal) and the
 * feedback record format. Transparent rules only: no model is trained here.
 */
import type { InvestigationState } from "./investigation";

export interface ReviewPriority {
  score: number; // 0..1, sum of listed rule weights (capped)
  level: "HIGH" | "MEDIUM" | "LOW";
  reasons: string[];
  method: string;
}

export function reviewPriority(s: InvestigationState): ReviewPriority {
  const reasons: string[] = [];
  let score = 0;
  const add = (w: number, why: string) => { score += w; reasons.push(why); };
  if (s.uncertainty?.overall === "HIGH") add(0.3, "overall uncertainty HIGH");
  if (s.environment?.low_wind_lookalike_risk) add(0.25, "low-wind SAR look-alike risk");
  const att = s.attribution;
  if (att && att.candidates.length >= 2 && (att.score_gap_top2 ?? 1) < 0.05) add(0.2, `top-2 candidates separated by only ${att.score_gap_top2}`);
  if (att?.candidates[0] && !att.candidates[0].sensitivity.stable) add(0.1, "top rank unstable under leave-one-factor-out");
  if (s.environment?.at_observation?.current_status === "NOT_AVAILABLE") add(0.1, "no ocean-current product");
  score = Math.min(1, Math.round(score * 100) / 100);
  return {
    score,
    level: score >= 0.6 ? "HIGH" : score >= 0.3 ? "MEDIUM" : "LOW",
    reasons,
    method: "Rule-based review priority (sum of transparent weights); ranks cases where investigator labels would be most informative. Not a learned active-learning model.",
  };
}

export interface FeedbackRecord {
  feedback_id: string;
  investigation_id: string;
  target: "detection" | "vessel" | "hypothesis";
  verdict: "confirmed" | "rejected" | "uncertain";
  mmsi?: string;
  hypothesis_id?: string;
  note?: string;
  created_at: string;
  status: "UNVERIFIED_INVESTIGATOR_INPUT";
}

const store: FeedbackRecord[] = [];

export interface FeedbackValidation { ok: boolean; record?: FeedbackRecord; error?: string }

export function validateFeedback(body: any, investigationExists: (id: string) => boolean): FeedbackValidation {
  const b = body ?? {};
  if (typeof b.investigation_id !== "string" || !investigationExists(b.investigation_id)) return { ok: false, error: "unknown investigation_id" };
  if (!["detection", "vessel", "hypothesis"].includes(b.target)) return { ok: false, error: "target must be detection | vessel | hypothesis" };
  if (!["confirmed", "rejected", "uncertain"].includes(b.verdict)) return { ok: false, error: "verdict must be confirmed | rejected | uncertain" };
  if (b.target === "vessel" && !(typeof b.mmsi === "string" && /^\d{6,12}$/.test(b.mmsi))) return { ok: false, error: "vessel feedback needs a numeric mmsi" };
  if (b.target === "hypothesis" && !["H1", "H2", "H3", "H4"].includes(b.hypothesis_id)) return { ok: false, error: "hypothesis_id must be H1..H4" };
  const note = typeof b.note === "string" ? b.note.slice(0, 500) : undefined;
  return {
    ok: true,
    record: {
      feedback_id: `FB-${Date.now().toString(36)}-${store.length + 1}`,
      investigation_id: b.investigation_id, target: b.target, verdict: b.verdict,
      mmsi: b.target === "vessel" ? b.mmsi : undefined, hypothesis_id: b.target === "hypothesis" ? b.hypothesis_id : undefined,
      note, created_at: new Date().toISOString(), status: "UNVERIFIED_INVESTIGATOR_INPUT",
    },
  };
}

export function addFeedback(r: FeedbackRecord) {
  store.push(r);
  if (store.length > 1000) store.shift();
}
export function listFeedback(): FeedbackRecord[] {
  return [...store];
}
