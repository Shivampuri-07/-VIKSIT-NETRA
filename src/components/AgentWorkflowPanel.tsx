import React, { useMemo, useState } from "react";
import { CheckCircle2, XCircle, MinusCircle, Circle, RefreshCw, AlertTriangle, Database, Clock } from "lucide-react";
import type { InvestigationView, NodeEvent, NodeStatus } from "../types";
import { levelColor } from "../lib/format";

interface Props {
  investigation: InvestigationView | null;
  events: NodeEvent[];
  nodeStatus: Record<string, NodeStatus>;
  isAnalyzing: boolean;
}

const StatusIcon: React.FC<{ s: NodeStatus }> = ({ s }) => {
  if (s === "completed") return <CheckCircle2 className="w-3.5 h-3.5 text-ok" />;
  if (s === "failed") return <XCircle className="w-3.5 h-3.5 text-danger" />;
  if (s === "skipped") return <MinusCircle className="w-3.5 h-3.5 text-faint" />;
  if (s === "running") return <RefreshCw className="w-3.5 h-3.5 text-navy-600 animate-spin" />;
  return <Circle className="w-3.5 h-3.5 text-faint" />;
};

export const AgentWorkflowPanel: React.FC<Props> = ({ investigation, events, nodeStatus, isAnalyzing }) => {
  const [selected, setSelected] = useState<string | null>(null);
  const nodes = investigation?.graph.nodes ?? [];
  const lastEventByNode = useMemo(() => {
    const m = new Map<string, NodeEvent>();
    for (const e of events) m.set(e.node, e);
    return m;
  }, [events]);
  const startedAt = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of events) if (e.status === "running" && !m.has(e.node)) m.set(e.node, e.at);
    return m;
  }, [events]);

  if (!investigation) {
    return (
      <div className="h-full flex items-center justify-center text-[11px] text-muted font-mono">
        {isAnalyzing ? "Starting investigation…" : "No investigation yet. Press Run Investigation."}
      </div>
    );
  }

  const running = nodes.find((n) => nodeStatus[n.id] === "running")?.id;
  const lastDone = [...events].reverse().find((e) => e.status === "completed" || e.status === "failed")?.node;
  const active = selected ?? running ?? lastDone ?? nodes[0]?.id;
  const ev = active ? lastEventByNode.get(active) : undefined;
  const node = nodes.find((n) => n.id === active);
  const totalMs = events.reduce((s, e) => s + (e.duration_ms ?? 0), 0);
  const summaries = events.filter((e) => e.status === "completed" && e.summary);

  return (
    <div className="h-full flex text-[11px] min-h-0">
      <div className="w-[260px] shrink-0 border-r border-line overflow-y-auto">
        <div className="px-3 py-1.5 text-[9px] text-muted font-mono border-b border-line space-y-1">
          <div>
            <span data-testid="orchestrator-badge" title={investigation.graph.orchestrator_info?.note ?? undefined}
              className={`inline-block mr-1 px-1 rounded border ${investigation.graph.orchestrator === "langgraph" ? "border-ok text-ok" : "border-warn text-warn"}`}>
              {investigation.graph.orchestrator_status ?? (investigation.graph.orchestrator === "langgraph" ? "LANGGRAPH" : "DETERMINISTIC_FALLBACK")}
            </span>
            {investigation.graph.runtime}
          </div>
          {investigation.graph.orchestrator_info && (
            <div className="text-[9px] leading-snug" data-testid="orchestrator-info">
              {investigation.graph.orchestrator_info.status === "LANGGRAPH"
                ? `${investigation.graph.orchestrator_info.package} ${investigation.graph.orchestrator_info.package_version} (core ${investigation.graph.orchestrator_info.core_version}); ${investigation.graph.orchestrator_info.graph_node_invocations} nodes were invoked by the LangGraph runtime.`
                : `Not LangGraph: ${investigation.graph.orchestrator_info.note ?? "deterministic orchestrator"}`}
              <br />Nodes are rule-based computation steps. No language model is used; nothing here is an AI-generated measurement.
            </div>
          )}
        </div>
        {nodes.map((n, i) => {
          const st = nodeStatus[n.id] ?? "pending";
          const e = lastEventByNode.get(n.id);
          return (
            <button key={n.id} onClick={() => setSelected(n.id)}
              className={`w-full text-left px-3 py-1.5 flex items-center gap-2 border-b border-line cursor-pointer ${active === n.id ? "bg-surface" : "hover:bg-subtle/60"}`}>
              <StatusIcon s={st} />
              <span className="font-mono text-[9px] text-faint w-4">{i + 1}</span>
              <span className={`flex-1 ${st === "skipped" || st === "pending" ? "text-muted" : "text-ink"}`}>{n.label}{n.conditional ? " ◇" : ""}</span>
              {e?.duration_ms !== undefined && <span className="font-mono text-[9px] text-muted">{e.duration_ms.toFixed(1)} ms</span>}
              {(e?.warnings?.length ?? 0) > 0 && <AlertTriangle className="w-3 h-3 text-warn" />}
            </button>
          );
        })}
        <div className="px-3 py-1.5 text-[9px] text-muted font-mono">
          {events.length} real events · compute {totalMs.toFixed(1)} ms · ◇ = conditional routing
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2 min-w-0">
        {node && (
          <>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <StatusIcon s={nodeStatus[node.id] ?? "pending"} />
                <span className="font-semibold text-ink text-[12px]">{node.label}</span>
                <span className="font-mono text-[9px] text-muted">{node.id}</span>
              </div>
              {ev?.confidence && (
                <span className="font-mono text-[9px] px-1.5 py-0.5 rounded border" style={{ color: levelColor(ev.confidence.level), borderColor: levelColor(ev.confidence.level) }}>
                  CONFIDENCE {ev.confidence.level}
                </span>
              )}
            </div>
            <div className="text-muted">{node.description}</div>
            <div className="flex flex-wrap gap-3 font-mono text-[9px] text-muted">
              <span className="flex items-center gap-1"><Clock className="w-3 h-3" />started {startedAt.get(node.id)?.slice(11, 23) ?? "—"}</span>
              <span>ended {ev && ev.status !== "running" ? ev.at.slice(11, 23) : "—"}</span>
              {ev?.duration_ms !== undefined && <span>{ev.duration_ms.toFixed(2)} ms</span>}
              {node.requires.length > 0 && <span>requires: {node.requires.join(", ")}</span>}
            </div>
            {ev?.summary && <div className="text-ink bg-surface border border-line rounded p-2">{ev.summary}</div>}
            {ev?.error && <div className="text-danger bg-danger-50 border border-danger/30 rounded p-2 font-mono">{ev.error}</div>}
            {ev?.confidence && <div className="text-[10px] text-muted">Confidence basis: {ev.confidence.basis}</div>}
            {!!ev?.evidence?.length && (
              <div>
                <div className="text-[9px] uppercase tracking-wider text-muted mb-0.5">Evidence discovered</div>
                <ul className="list-disc list-inside space-y-0.5 text-ink">{ev.evidence.map((x, i) => <li key={i}>{x}</li>)}</ul>
              </div>
            )}
            {!!ev?.warnings?.length && (
              <div>
                <div className="text-[9px] uppercase tracking-wider text-warn mb-0.5">Warnings</div>
                <ul className="list-disc list-inside space-y-0.5 text-warn">{ev.warnings.map((x, i) => <li key={i}>{x}</li>)}</ul>
              </div>
            )}
            {!!ev?.data_sources?.length && (
              <div className="flex flex-wrap gap-1 items-center">
                <Database className="w-3 h-3 text-muted" />
                {ev.data_sources.map((d, i) => <span key={i} className="font-mono text-[9px] px-1.5 py-0.5 rounded bg-subtle text-muted">{d}</span>)}
              </div>
            )}
          </>
        )}
      </div>

      <div className="w-[300px] shrink-0 border-l border-line overflow-y-auto p-3 hidden xl:block">
        <div className="text-[9px] uppercase tracking-wider text-muted mb-1">Final reasoning summary</div>
        {investigation.status === "running" && <div className="text-muted italic">Investigation in progress…</div>}
        <ol className="space-y-1 list-decimal list-inside text-[10px] text-ink">
          {summaries.map((e) => <li key={e.seq}><span className="text-navy-600">{e.label}:</span> {e.summary}</li>)}
        </ol>
      </div>
    </div>
  );
};
