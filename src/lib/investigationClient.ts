import type { InvestigationView, NodeEvent, FactorWeights } from "../types";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { msg = (await res.json()).error ?? msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export async function startInvestigation(sceneId: string, params: Record<string, unknown>): Promise<string> {
  const res = await fetch("/api/investigations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scene_id: sceneId, params }),
  });
  const data = await json<{ investigation_id: string }>(res);
  return data.investigation_id;
}

export async function fetchInvestigation(id: string): Promise<InvestigationView> {
  return json<InvestigationView>(await fetch(`/api/investigations/${encodeURIComponent(id)}`));
}

export async function rerunInvestigation(id: string, weights: FactorWeights): Promise<InvestigationView> {
  const res = await fetch(`/api/investigations/${encodeURIComponent(id)}/rerun`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ weights, from: "evidence_fusion" }),
  });
  return json<InvestigationView>(res);
}

async function pollUntilDone(id: string, onEvent: (e: NodeEvent) => void, seen: Set<number>): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const view = await fetchInvestigation(id);
    for (const e of view.events) if (!seen.has(e.seq)) { seen.add(e.seq); onEvent(e); }
    if (view.status !== "running") return;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("Investigation did not finish within 120 s");
}

/**
 * Streams REAL node events from the server (Server-Sent Events). If the
 * stream cannot be opened (proxy, sandbox), falls back to polling the same
 * events. Resolves when the investigation has finished.
 */
export function streamInvestigation(id: string, onEvent: (e: NodeEvent) => void): Promise<void> {
  const seen = new Set<number>();
  const handle = (e: NodeEvent) => { if (!seen.has(e.seq)) { seen.add(e.seq); onEvent(e); } };
  if (typeof EventSource === "undefined") return pollUntilDone(id, handle, seen);
  return new Promise<void>((resolve, reject) => {
    let done = false;
    let lastActivity = Date.now();
    const es = new EventSource(`/api/investigations/${encodeURIComponent(id)}/stream`);
    const finish = () => { if (!done) { done = true; clearInterval(watchdog); es.close(); resolve(); } };
    const fallBackToPolling = () => {
      if (done) return;
      done = true;
      clearInterval(watchdog);
      es.close();
      pollUntilDone(id, handle, seen).then(resolve, reject);
    };
    // Watchdog: if the stream goes silent (proxy buffering, dropped listener),
    // switch to polling instead of waiting forever.
    const watchdog = setInterval(() => { if (Date.now() - lastActivity > 5000) fallBackToPolling(); }, 1000);
    es.addEventListener("node", (m) => {
      lastActivity = Date.now();
      try { handle(JSON.parse((m as MessageEvent).data)); } catch { /* ignore malformed */ }
    });
    es.addEventListener("complete", finish);
    es.onerror = fallBackToPolling;
  });
}
