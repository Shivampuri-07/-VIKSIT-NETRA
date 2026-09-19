import React from "react";
import { Satellite, Wind, Route, Ship, Brain, CheckCircle2, Play, RefreshCw, XCircle, MinusCircle } from "lucide-react";
import type { NodeStatus } from "../types";

interface WorkflowStepperProps {
  nodeStatus: Record<string, NodeStatus>;
  isAnalyzing: boolean;
  onRunFullAnalysis: () => void;
  onReset: () => void;
}

/** Stages are groups of REAL investigation-graph nodes; status comes from backend events. */
const STAGES = [
  { title: "Detection", subtitle: "SAR slick + geometry", icon: Satellite, nodes: ["satellite_detection", "spill_characterization"] },
  { title: "Environment", subtitle: "ERA5 wind / currents", icon: Wind, nodes: ["environmental_analysis"] },
  { title: "Drift Physics", subtitle: "Backtrack + forecast", icon: Route, nodes: ["backward_origin", "forward_forecast"] },
  { title: "AIS Evidence", subtitle: "Candidates + fusion", icon: Ship, nodes: ["ais_investigation", "evidence_fusion"] },
  { title: "Intelligence", subtitle: "Hypotheses → report", icon: Brain, nodes: ["competing_hypotheses", "uncertainty", "risk_assessment", "response_recommendation", "report_generation"] },
];

function stageStatus(nodes: string[], st: Record<string, NodeStatus>): NodeStatus {
  const s = nodes.map((n) => st[n] ?? "pending");
  if (s.includes("failed")) return "failed";
  if (s.includes("running")) return "running";
  if (s.every((x) => x === "skipped")) return "skipped";
  if (s.every((x) => x === "completed" || x === "skipped")) return "completed";
  if (s.some((x) => x === "completed")) return "running";
  return "pending";
}

export const WorkflowStepper: React.FC<WorkflowStepperProps> = ({ nodeStatus, isAnalyzing, onRunFullAnalysis, onReset }) => (
  <div className="bg-[#161B22] border-b border-[#30363D] px-5 py-2 flex flex-col md:flex-row md:items-center justify-between gap-3 shrink-0 select-none">
    <div className="flex items-center overflow-x-auto gap-2 no-scrollbar">
      {STAGES.map((s, i) => {
        const st = stageStatus(s.nodes, nodeStatus);
        const Icon = s.icon;
        const cls =
          st === "completed" ? "bg-[#238636]/15 border-[#238636] text-[#AFF5B4]"
          : st === "running" ? "bg-[#58A6FF]/15 border-[#58A6FF] text-[#C9D1D9]"
          : st === "failed" ? "bg-[#f85149]/15 border-[#f85149] text-[#f85149]"
          : st === "skipped" ? "bg-[#0D1117] border-[#30363D] text-[#484F58]"
          : "bg-[#0D1117] border-[#30363D] text-[#8B949E]";
        const done = s.nodes.filter((n) => nodeStatus[n] === "completed").length;
        return (
          <div key={s.title} className="flex items-center gap-2 shrink-0">
            <div className={`flex items-center gap-2 px-2.5 py-1.5 rounded-[4px] border ${cls}`} title={s.nodes.map((n) => `${n}: ${nodeStatus[n] ?? "pending"}`).join("\n")}>
              <div className="w-5 h-5 flex items-center justify-center">
                {st === "completed" ? <CheckCircle2 className="w-3.5 h-3.5" /> : st === "failed" ? <XCircle className="w-3.5 h-3.5" /> : st === "skipped" ? <MinusCircle className="w-3.5 h-3.5" /> : st === "running" ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Icon className="w-3.5 h-3.5" />}
              </div>
              <div className="flex flex-col">
                <span className="text-[11px] font-semibold leading-tight">{s.title}</span>
                <span className="text-[9px] text-[#8B949E] font-mono leading-tight">{s.subtitle} · {done}/{s.nodes.length}</span>
              </div>
            </div>
            {i < STAGES.length - 1 && <span className="text-[#30363D] hidden lg:inline font-mono">→</span>}
          </div>
        );
      })}
    </div>
    <div className="flex items-center gap-2 shrink-0 self-end md:self-auto">
      <button onClick={onRunFullAnalysis} disabled={isAnalyzing} className="px-4 py-1.5 rounded-[4px] bg-[#58A6FF] hover:bg-[#79C0FF] disabled:opacity-50 text-[#0D1117] text-xs font-bold flex items-center gap-2 cursor-pointer border border-[#58A6FF]">
        {isAnalyzing ? (<><RefreshCw className="w-3.5 h-3.5 animate-spin" /><span className="font-mono uppercase tracking-wider">Running…</span></>) : (<><Play className="w-3.5 h-3.5 fill-current" /><span>Run Investigation</span></>)}
      </button>
      <button onClick={onReset} disabled={isAnalyzing} title="Clear results" className="p-1.5 rounded-[4px] bg-[#161B22] hover:bg-[#21262D] text-[#8B949E] text-xs border border-[#30363D] cursor-pointer">
        <RefreshCw className="w-3.5 h-3.5" />
      </button>
    </div>
  </div>
);
