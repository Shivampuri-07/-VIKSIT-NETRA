import React, { useState, useEffect } from "react";
import { Bot, BarChart3, Scale, ChevronDown, ChevronUp, FlaskConical } from "lucide-react";
import type { InvestigationView, NodeEvent, NodeStatus, DriftResult, EnvironmentState, CandidateRanking, VesselScoreDetail } from "../types";
import { AgentWorkflowPanel } from "./AgentWorkflowPanel";
import { AnalyticsPanel } from "./AnalyticsPanel";
import { HypothesesPanel } from "./HypothesesPanel";
import { CounterfactualPanel } from "./CounterfactualPanel";

interface Props {
  investigation: InvestigationView | null;
  events: NodeEvent[];
  nodeStatus: Record<string, NodeStatus>;
  isAnalyzing: boolean;
  forward: DriftResult | null;
  backward: DriftResult | null;
  environment: EnvironmentState | null;
  attribution: CandidateRanking | null;
  selectedVessel: VesselScoreDetail | null;
  counterfactuals: any[];
  counterfactualBusy: boolean;
  onRunSensitivity: () => void;
}

type Tab = "agents" | "analytics" | "hypotheses" | "counterfactuals";

export const IntelligenceDock: React.FC<Props> = (p) => {
  const [tab, setTab] = useState<Tab>("agents");
  const [open, setOpen] = useState(true);
  // show a new counterfactual result as soon as it arrives
  useEffect(() => {
    if (p.counterfactuals.length) { setTab("counterfactuals"); setOpen(true); }
  }, [p.counterfactuals.length]);
  const tabs: { id: Tab; label: string; icon: React.ElementType }[] = [
    { id: "agents", label: "Investigation Agents", icon: Bot },
    { id: "analytics", label: "Analytics", icon: BarChart3 },
    { id: "hypotheses", label: "Hypotheses · Uncertainty · Risk", icon: Scale },
    { id: "counterfactuals", label: "Counterfactuals", icon: FlaskConical },
  ];
  return (
    <div className={`shrink-0 border-t border-[#30363D] bg-[#0D1117] flex flex-col ${open ? "h-[310px]" : "h-[34px]"}`}>
      <div className="h-[34px] shrink-0 flex items-center justify-between px-3 bg-[#161B22] border-b border-[#30363D]">
        <div className="flex items-center gap-1">
          {tabs.map((t) => {
            const Icon = t.icon;
            return (
              <button key={t.id} onClick={() => { setTab(t.id); setOpen(true); }}
                className={`px-2.5 py-1 rounded-[3px] text-[10px] font-mono flex items-center gap-1.5 cursor-pointer border ${tab === t.id && open ? "bg-[#58A6FF]/15 text-[#79C0FF] border-[#58A6FF]/40" : "text-[#8B949E] border-transparent hover:text-[#C9D1D9]"}`}>
                <Icon className="w-3.5 h-3.5" />{t.label}
              </button>
            );
          })}
        </div>
        <button onClick={() => setOpen((o) => !o)} className="text-[#8B949E] hover:text-[#C9D1D9] cursor-pointer" title={open ? "Collapse" : "Expand"}>
          {open ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
        </button>
      </div>
      {open && (
        <div className="flex-1 min-h-0 overflow-hidden">
          {tab === "agents" && <AgentWorkflowPanel investigation={p.investigation} events={p.events} nodeStatus={p.nodeStatus} isAnalyzing={p.isAnalyzing} />}
          {tab === "analytics" && <AnalyticsPanel forward={p.forward} backward={p.backward} environment={p.environment} attribution={p.attribution} selectedVessel={p.selectedVessel} />}
          {tab === "hypotheses" && <HypothesesPanel investigation={p.investigation} />}
          {tab === "counterfactuals" && (
            <CounterfactualPanel results={p.counterfactuals} busy={p.counterfactualBusy}
              canRun={!!p.investigation && p.investigation.status === "completed" && !p.isAnalyzing} onRunSensitivity={p.onRunSensitivity} />
          )}
        </div>
      )}
    </div>
  );
};
