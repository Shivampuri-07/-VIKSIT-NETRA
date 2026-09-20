import React from "react";
import { Check, X, Minus, Loader2, Play, RotateCcw } from "lucide-react";
import type { NodeStatus } from "../types";

interface WorkflowStepperProps {
  nodeStatus: Record<string, NodeStatus>;
  isAnalyzing: boolean;
  onRunFullAnalysis: () => void;
  onReset: () => void;
}

/** Stages group REAL investigation-graph nodes; status comes from the backend node events. */
const STAGES = [
  { title: "Detection", subtitle: "SAR slick + geometry", nodes: ["satellite_detection", "spill_characterization"] },
  { title: "Environment", subtitle: "Wind + current forcing", nodes: ["environmental_analysis"] },
  { title: "Drift physics", subtitle: "Backtrack + forecast", nodes: ["backward_origin", "forward_forecast"] },
  { title: "AIS evidence", subtitle: "Candidates + fusion", nodes: ["ais_investigation", "evidence_fusion"] },
  { title: "Intelligence", subtitle: "Hypotheses → report", nodes: ["competing_hypotheses", "uncertainty", "risk_assessment", "response_recommendation", "report_generation"] },
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

const STATUS_TEXT: Record<NodeStatus, string> = {
  completed: "Complete",
  running: "Running",
  failed: "Failed",
  skipped: "Skipped",
  pending: "Pending",
};

const Indicator: React.FC<{ status: NodeStatus; index: number }> = ({ status, index }) => {
  const base = "w-6 h-6 rounded-full flex items-center justify-center shrink-0 text-[10px] font-semibold vn-num";
  if (status === "completed") return <span className={`${base} bg-ok-50 text-ok border border-ok/30`}><Check className="w-3.5 h-3.5" aria-hidden="true" /></span>;
  if (status === "failed") return <span className={`${base} bg-danger-50 text-danger border border-danger/30`}><X className="w-3.5 h-3.5" aria-hidden="true" /></span>;
  if (status === "running") return <span className={`${base} bg-navy-50 text-navy-600 border border-navy-600/30`}><Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /></span>;
  if (status === "skipped") return <span className={`${base} bg-subtle text-faint border border-line`}><Minus className="w-3.5 h-3.5" aria-hidden="true" /></span>;
  return <span className={`${base} bg-subtle text-muted border border-line`}>{String(index + 1).padStart(2, "0")}</span>;
};

/** Horizontal workflow tracker for the five investigation stages, plus the primary action. */
export const WorkflowStepper: React.FC<WorkflowStepperProps> = ({ nodeStatus, isAnalyzing, onRunFullAnalysis, onReset }) => (
  <div className="bg-surface border-b border-line px-4 lg:px-5 py-2 flex flex-col lg:flex-row lg:items-center justify-between gap-3 shrink-0 select-none">
    <ol className="flex items-center gap-1 overflow-x-auto no-scrollbar min-w-0" aria-label="Investigation progress">
      {STAGES.map((s, i) => {
        const st = stageStatus(s.nodes, nodeStatus);
        const done = s.nodes.filter((n) => nodeStatus[n] === "completed").length;
        return (
          <li key={s.title} className="flex items-center gap-1 shrink-0">
            <div
              className={`flex items-center gap-2.5 pl-2 pr-3 py-1.5 rounded-[9px] border ${
                st === "completed"
                  ? "border-ok/25 bg-ok-50/50"
                  : st === "running"
                    ? "border-navy-600/30 bg-navy-50"
                    : st === "failed"
                      ? "border-danger/30 bg-danger-50"
                      : "border-line bg-surface"
              }`}
              title={s.nodes.map((n) => `${n}: ${nodeStatus[n] ?? "pending"}`).join("\n")}
            >
              <Indicator status={st} index={i} />
              <div className="leading-tight">
                <div className="text-[12px] font-medium text-ink whitespace-nowrap">{s.title}</div>
                <div className="text-[10px] text-muted whitespace-nowrap">
                  {STATUS_TEXT[st]} · {done}/{s.nodes.length} · <span className="hidden xl:inline">{s.subtitle}</span>
                </div>
              </div>
            </div>
            {i < STAGES.length - 1 && <span className="w-4 h-px bg-line-strong hidden lg:block" aria-hidden="true" />}
          </li>
        );
      })}
    </ol>

    <div className="flex items-center gap-2 shrink-0 w-full justify-end lg:w-auto">
      <button onClick={onReset} disabled={isAnalyzing} title="Clear the current results" className="vn-btn" aria-label="Clear results">
        <RotateCcw className="w-3.5 h-3.5 text-muted" aria-hidden="true" />
        <span className="hidden sm:inline">Clear</span>
      </button>
      <button onClick={onRunFullAnalysis} disabled={isAnalyzing} className="vn-btn vn-btn-primary px-4 py-2" data-testid="run-investigation">
        {isAnalyzing ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
            Running investigation…
          </>
        ) : (
          <>
            <Play className="w-3.5 h-3.5" aria-hidden="true" />
            Run investigation
          </>
        )}
      </button>
    </div>
  </div>
);
