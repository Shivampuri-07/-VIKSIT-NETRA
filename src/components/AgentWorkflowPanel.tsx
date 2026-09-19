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
  if (s === "completed") return <CheckCircle2 className="w-3.5 h-3.5 text-[#3fb950]" />;
  if (s === "failed") return <XCircle className="w-3.5 h-3.5 text-[#f85149]" />;
  if (s === "skipped") return <MinusCircle className="w-3.5 h-3.5 text-[#484F58]" />;
  if (s === "running") return <RefreshCw className="w-3.5 h-3.5 text-[#58A6FF] animate-spin" />;
  return <Circle className="w-3.5 h-3.5 text-[#484F58]" />;
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
      <div className="h-full flex items-center justify-center text-[11px] text-[#8B949E] font-mono">
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
      <div className="w-[260px] shrink-0 border-r border-[#30363D] overflow-y-auto">
        <div className="px-3 py-1.5 text-[9px] text-[#8B949E] font-mono border-b border-[#30363D] space-y-1">
          <div>
            <span data-testid="orchestrator-badge" title={investigation.graph.orchestrator_info?.note ?? undefined}
              className={`inline-block mr-1 px-1 rounded border ${investigation.graph.orchestrator === "langgraph" ? "border-[#3fb950] text-[#3fb950]" : "border-[#d29922] text-[#d29922]"}`}>
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
              className={`w-full text-left px-3 py-1.5 flex items-center gap-2 border-b border-[#21262D] cursor-pointer ${active === n.id ? "bg-[#161B22]" : "hover:bg-[#161B22]/60"}`}>
              <StatusIcon s={st} />
              <span className="font-mono text-[9px] text-[#484F58] w-4">{i + 1}</span>
              <span className={`flex-1 ${st === "skipped" || st === "pending" ? "text-[#8B949E]" : "text-[#C9D1D9]"}`}>{n.label}{n.conditional ? " ◇" : ""}</span>
              {e?.duration_ms !== undefined && <span className="font-mono text-[9px] text-[#8B949E]">{e.duration_ms.toFixed(1)} ms</span>}
              {(e?.warnings?.length ?? 0) > 0 && <AlertTriangle className="w-3 h-3 text-[#d29922]" />}
            </button>
          );
        })}
        <div className="px-3 py-1.5 text-[9px] text-[#8B949E] font-mono">
          {events.length} real events · compute {totalMs.toFixed(1)} ms · ◇ = conditional routing
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2 min-w-0">
        {node && (
          <>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <StatusIcon s={nodeStatus[node.id] ?? "pending"} />
                <span className="font-semibold text-[#C9D1D9] text-[12px]">{node.label}</span>
                <span className="font-mono text-[9px] text-[#8B949E]">{node.id}</span>
              </div>
              {ev?.confidence && (
                <span className="font-mono text-[9px] px-1.5 py-0.5 rounded border" style={{ color: levelColor(ev.confidence.level), borderColor: levelColor(ev.confidence.level) }}>
                  CONFIDENCE {ev.confidence.level}
                </span>
              )}
            </div>
            <div className="text-[#8B949E]">{node.description}</div>
            <div className="flex flex-wrap gap-3 font-mono text-[9px] text-[#8B949E]">
              <span className="flex items-center gap-1"><Clock className="w-3 h-3" />started {startedAt.get(node.id)?.slice(11, 23) ?? "—"}</span>
              <span>ended {ev && ev.status !== "running" ? ev.at.slice(11, 23) : "—"}</span>
              {ev?.duration_ms !== undefined && <span>{ev.duration_ms.toFixed(2)} ms</span>}
              {node.requires.length > 0 && <span>requires: {node.requires.join(", ")}</span>}
            </div>
            {ev?.summary && <div className="text-[#C9D1D9] bg-[#161B22] border border-[#30363D] rounded p-2">{ev.summary}</div>}
            {ev?.error && <div className="text-[#f85149] bg-[#f85149]/10 border border-[#f85149]/30 rounded p-2 font-mono">{ev.error}</div>}
            {ev?.confidence && <div className="text-[10px] text-[#8B949E]">Confidence basis: {ev.confidence.basis}</div>}
            {!!ev?.evidence?.length && (
              <div>
                <div className="text-[9px] uppercase tracking-wider text-[#8B949E] mb-0.5">Evidence discovered</div>
                <ul className="list-disc list-inside space-y-0.5 text-[#C9D1D9]">{ev.evidence.map((x, i) => <li key={i}>{x}</li>)}</ul>
              </div>
            )}
            {!!ev?.warnings?.length && (
              <div>
                <div className="text-[9px] uppercase tracking-wider text-[#d29922] mb-0.5">Warnings</div>
                <ul className="list-disc list-inside space-y-0.5 text-[#d29922]">{ev.warnings.map((x, i) => <li key={i}>{x}</li>)}</ul>
              </div>
            )}
            {!!ev?.data_sources?.length && (
              <div className="flex flex-wrap gap-1 items-center">
                <Database className="w-3 h-3 text-[#8B949E]" />
                {ev.data_sources.map((d, i) => <span key={i} className="font-mono text-[9px] px-1.5 py-0.5 rounded bg-[#21262D] text-[#8B949E]">{d}</span>)}
              </div>
            )}
          </>
        )}
      </div>

      <div className="w-[300px] shrink-0 border-l border-[#30363D] overflow-y-auto p-3 hidden xl:block">
        <div className="text-[9px] uppercase tracking-wider text-[#8B949E] mb-1">Final reasoning summary</div>
        {investigation.status === "running" && <div className="text-[#8B949E] italic">Investigation in progress…</div>}
        <ol className="space-y-1 list-decimal list-inside text-[10px] text-[#C9D1D9]">
          {summaries.map((e) => <li key={e.seq}><span className="text-[#79C0FF]">{e.label}:</span> {e.summary}</li>)}
        </ol>
      </div>
    </div>
  );
};
