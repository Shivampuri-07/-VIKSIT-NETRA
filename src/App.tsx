import React, { useState, useEffect, useCallback, useRef } from "react";
import { Header } from "./components/Header";
import { SceneSelector } from "./components/SceneSelector";
import { WorkflowStepper } from "./components/WorkflowStepper";
import { SpillCharacterizationPanel } from "./components/SpillCharacterizationPanel";
import { GisMap } from "./components/GisMap";
import { CandidatePanel } from "./components/CandidatePanel";
import { WeightsModal } from "./components/WeightsModal";
import { DriftSettingsModal } from "./components/DriftSettingsModal";
import { MLDiagnosticsModal } from "./components/MLDiagnosticsModal";
import { RealDataGuideModal } from "./components/RealDataGuideModal";
import { TestRunnerModal } from "./components/TestRunnerModal";
import { IntelligenceDock } from "./components/IntelligenceDock";
import { SidePanel } from "./components/SidePanel";
import {
  Scene, SpillDetection, DriftSimulation, CandidateRanking, VesselScoreDetail,
  InvestigationView, NodeEvent, NodeStatus, DriftResult, EnvironmentState, FactorWeights, DriftSettings,
} from "./types";
import { toLegacyDrift, toLegacyAttribution, envSummaryFromInvestigation } from "../server/lib/legacy";
import { startInvestigation, streamInvestigation, fetchInvestigation, rerunInvestigation } from "./lib/investigationClient";
import { fmtLatLon } from "./lib/format";
import { generateIncidentReport } from "./report/generateReport";
import { Compass, Clock, AlertTriangle, X, Sparkles, Ship, Globe, BarChart3, PanelRightOpen } from "lucide-react";

const REAL_SCENE_ID = "GOM_S1A_20180926_REAL";
const nowUtc = () => new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";

export function App() {
  const [appMode, setAppMode] = useState<"DEMO" | "REAL">("REAL");
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [selectedSceneId, setSelectedSceneId] = useState<string>(REAL_SCENE_ID);

  const [detection, setDetection] = useState<SpillDetection | null>(null);
  const [drift, setDrift] = useState<DriftSimulation | null>(null);
  const [forward, setForward] = useState<DriftResult | null>(null);
  const [environment, setEnvironment] = useState<EnvironmentState | null>(null);
  const [attribution, setAttribution] = useState<CandidateRanking | null>(null);
  const [selectedVessel, setSelectedVessel] = useState<VesselScoreDetail | null>(null);
  const [investigation, setInvestigation] = useState<InvestigationView | null>(null);
  const [events, setEvents] = useState<NodeEvent[]>([]);
  const [nodeStatus, setNodeStatus] = useState<Record<string, NodeStatus>>({});

  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reportMsg, setReportMsg] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(nowUtc());

  const [isWeightsOpen, setIsWeightsOpen] = useState(false);
  const [isDriftOpen, setIsDriftOpen] = useState(false);
  const [isMLOpen, setIsMLOpen] = useState(false);
  const [isRealGuideOpen, setIsRealGuideOpen] = useState(false);
  const [isTestsOpen, setIsTestsOpen] = useState(false);

  const [weights, setWeights] = useState<FactorWeights>({ spatial: 0.35, temporal: 0.25, trajectory: 0.25, consistency: 0.15 });
  const [driftParams, setDriftParams] = useState<DriftSettings>({
    driftHours: 12, numParticles: 300, windFactor: 0.03, eddyDiffusivity: 2.5, unknownCurrentSigma: 0.1,
  });
  const selectedMmsiRef = useRef<string | null>(null);
  const autoRanRef = useRef(false);

  // Focus map: the SAME map instance is enlarged (never remounted), so scene, layers, time/horizon and selection are preserved.
  const [focusMap, setFocusMap] = useState<boolean>(() => { try { return new URLSearchParams(window.location.search).get("focus") === "1"; } catch { return false; } });
  const [drawer, setDrawer] = useState<"scene" | "spill" | "candidates" | "analysis" | null>(() => {
    try { const d = new URLSearchParams(window.location.search).get("drawer"); return d === "scene" || d === "spill" || d === "candidates" || d === "analysis" ? d : null; } catch { return null; }
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !focusMap) return;
      if (drawer) setDrawer(null); else setFocusMap(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusMap, drawer]);
  const toggleFocus = useCallback(() => { setFocusMap((f) => !f); setDrawer(null); }, []);

  useEffect(() => {
    const t = setInterval(() => setCurrentTime(nowUtc()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    fetch("/api/health").then((r) => r.json()).then((d) => {
      if (d.mode === "REAL" || d.mode === "DEMO") setAppMode(d.mode);
    }).catch((e) => console.error("Health check error:", e));
    fetch("/api/scenes").then((r) => r.json()).then((d) => {
      if (Array.isArray(d.scenes) && d.scenes.length) {
        setScenes(d.scenes);
        const real = d.scenes.find((s: Scene) => s.scene_id === REAL_SCENE_ID);
        setSelectedSceneId(real ? real.scene_id : d.scenes[0].scene_id);
      }
    }).catch((e) => setError(`Could not load scenes: ${e.message}`));
  }, []);

  const [counterfactuals, setCounterfactuals] = useState<any[]>([]);
  const [cfBusy, setCfBusy] = useState(false);

  const applyView = useCallback((view: InvestigationView) => {
    const s = view.state;
    setCounterfactuals([]); // results of the previous state are stale
    setInvestigation(view);
    setEvents(view.events);
    setNodeStatus(Object.fromEntries(view.graph.nodes.map((n) => [n.id, n.status])));
    setDetection(s.detection ?? null);
    setForward(s.forward ?? null);
    setEnvironment(s.environment ?? null);
    const env = envSummaryFromInvestigation(s.environment);
    if (s.backward && s.detection) {
      setDrift(toLegacyDrift(s.backward, { simulation_id: view.investigation_id, spill_id: s.detection.spill_id }, env, s.detection.geometry.orientation_deg, !!s.detection.real_data) as unknown as DriftSimulation);
    } else setDrift(null);
    if (s.attribution && s.detection && s.ais) {
      const att = toLegacyAttribution(s.attribution, { spill_id: s.detection.spill_id, scene_id: s.detection.scene_id }, env, s.detection.geometry.orientation_deg, { source: s.ais.source, records: s.ais.records, synthetic: s.ais.synthetic }) as unknown as CandidateRanking;
      setAttribution(att);
      const keep = att.top_candidates.find((c) => c.mmsi === selectedMmsiRef.current);
      const next = keep ?? att.top_candidates[0] ?? null;
      selectedMmsiRef.current = next?.mmsi ?? null;
      setSelectedVessel(next);
    } else {
      setAttribution(null);
      setSelectedVessel(null);
    }
  }, []);

  const runFullAnalysis = useCallback(async (sceneId: string, params: DriftSettings, w: FactorWeights) => {
    setIsAnalyzing(true);
    setError(null);
    setDetection(null); setDrift(null); setForward(null); setEnvironment(null); setAttribution(null);
    setSelectedVessel(null); setInvestigation(null); setEvents([]); setNodeStatus({});
    try {
      const id = await startInvestigation(sceneId, {
        backtrack_hours: params.driftHours,
        forecast_hours: [6, 12, 24, 48],
        num_particles: params.numParticles,
        wind_factor: params.windFactor,
        eddy_diffusivity: params.eddyDiffusivity,
        unknown_current_sigma: params.unknownCurrentSigma,
        weights: w,
      });
      const first = await fetchInvestigation(id);
      setInvestigation(first);
      setNodeStatus(Object.fromEntries(first.graph.nodes.map((n) => [n.id, n.status])));
      await streamInvestigation(id, (e) => {
        setEvents((prev) => (prev.some((p) => p.seq === e.seq) ? prev : [...prev, e]));
        setNodeStatus((prev) => ({ ...prev, [e.node]: e.status }));
      });
      applyView(await fetchInvestigation(id));
    } catch (e) {
      console.error("Investigation failed:", e);
      setError(`Investigation failed: ${(e as Error).message}`);
    } finally {
      setIsAnalyzing(false);
    }
  }, [applyView]);

  useEffect(() => {
    if (scenes.length && !autoRanRef.current) {
      autoRanRef.current = true;
      runFullAnalysis(selectedSceneId, driftParams, weights);
    }
  }, [scenes, selectedSceneId, driftParams, weights, runFullAnalysis]);

  const handleSceneSelect = (id: string) => {
    setSelectedSceneId(id);
    selectedMmsiRef.current = null;
    runFullAnalysis(id, driftParams, weights);
  };

  const handleReset = () => {
    setDetection(null); setDrift(null); setForward(null); setEnvironment(null); setAttribution(null);
    setSelectedVessel(null); setInvestigation(null); setEvents([]); setNodeStatus({}); setError(null);
  };

  const handleModeToggle = (mode: "DEMO" | "REAL") => {
    setAppMode(mode);
    fetch("/api/config/mode", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode }) }).catch(console.error);
    if (mode === "REAL") setIsRealGuideOpen(true);
  };

  const handleWeightsSave = async (w: FactorWeights) => {
    setWeights(w);
    if (!investigation || isAnalyzing) return;
    setIsAnalyzing(true);
    try {
      applyView(await rerunInvestigation(investigation.investigation_id, w));
    } catch (e) {
      setError(`Re-scoring failed: ${(e as Error).message}`);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleDriftSave = (p: DriftSettings) => {
    setDriftParams(p);
    runFullAnalysis(selectedSceneId, p, weights); // explicit params: no stale closure
  };

  const handleSelectVessel = (v: VesselScoreDetail | null) => {
    selectedMmsiRef.current = v?.mmsi ?? null;
    setSelectedVessel(v);
  };

  /** Counterfactual analysis on the CURRENT investigation (server-side engines). */
  const runCounterfactual = async (kind: "exclude_vessel" | "forcing_sensitivity", mmsi?: string) => {
    if (!investigation || isAnalyzing || cfBusy) return;
    setCfBusy(true);
    try {
      const r = await fetch(`/api/investigations/${encodeURIComponent(investigation.investigation_id)}/counterfactual`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, mmsi }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? r.statusText);
      setCounterfactuals((prev) => [d, ...prev].slice(0, 10));
    } catch (e) {
      setError(`Counterfactual failed: ${(e as Error).message}`);
    } finally {
      setCfBusy(false);
    }
  };

  const activeScene = scenes.find((s) => s.scene_id === selectedSceneId) ?? scenes[0] ?? null;

  const [reportBusy, setReportBusy] = useState(false);
  const reportDisabledReason = !investigation
    ? "Run an investigation first"
    : isAnalyzing || investigation.status === "running"
      ? "Investigation running"
      : reportBusy
        ? "Generating report..."
        : undefined;

  /** Builds the PDF from the CURRENT investigation state + viewer selections. */
  const handleDownloadReport = async (ctx: { horizon: number | "ALL" }) => {
    if (!investigation || reportDisabledReason) return;
    setReportBusy(true);
    setReportMsg("Generating incident report...");
    const r = await generateIncidentReport({
      investigation,
      scene: activeScene,
      selectedVesselMmsi: selectedVessel?.mmsi ?? null,
      forecastHorizon: ctx.horizon,
      counterfactuals,
    });
    setReportBusy(false);
    if (r.ok) setReportMsg(r.message);
    else { setReportMsg(null); setError(r.message); }
  };

  return (
    <div className="flex flex-col min-h-screen w-full md:h-screen md:w-screen bg-[#0D1117] text-[#C9D1D9] font-sans antialiased md:overflow-hidden">
      <Header
        appMode={appMode}
        onToggleMode={handleModeToggle}
        onOpenWeights={() => setIsWeightsOpen(true)}
        onOpenDriftSettings={() => setIsDriftOpen(true)}
        onOpenMLDiagnostics={() => setIsMLOpen(true)}
        onOpenRealGuide={() => setIsRealGuideOpen(true)}
        onOpenTests={() => setIsTestsOpen(true)}
        isAnalyzing={isAnalyzing}
      />
      <SceneSelector scenes={scenes} selectedSceneId={selectedSceneId} onSelectScene={handleSceneSelect} isAnalyzing={isAnalyzing} environment={environment} />
      <WorkflowStepper
        nodeStatus={nodeStatus}
        isAnalyzing={isAnalyzing}
        onRunFullAnalysis={() => runFullAnalysis(selectedSceneId, driftParams, weights)}
        onReset={handleReset}
      />
      {(error || reportMsg) && (
        <div className={`px-5 py-1.5 text-[11px] font-mono flex items-center justify-between border-b ${error ? "bg-[#f85149]/10 text-[#f85149] border-[#f85149]/30" : "bg-[#58A6FF]/10 text-[#79C0FF] border-[#58A6FF]/30"}`}>
          <span className="flex items-center gap-2"><AlertTriangle className="w-3.5 h-3.5" />{error ?? reportMsg}</span>
          <button onClick={() => { setError(null); setReportMsg(null); }} className="cursor-pointer"><X className="w-3.5 h-3.5" /></button>
        </div>
      )}

      <main className="md:flex-1 flex flex-col md:flex-row md:overflow-hidden relative md:min-h-0">
        <div className="hidden md:flex h-full shrink-0">
          <SidePanel side="left" title="Spill & Environment" icon={Sparkles} storageKey="aegis.panel.left" widthClass="md:w-72 lg:w-80">
            <SpillCharacterizationPanel scene={activeScene} detection={detection} drift={drift} environment={environment} investigation={investigation} />
          </SidePanel>
        </div>
        <div className="md:flex-1 flex flex-col min-w-0 md:min-h-0">
          {/* The map wrapper only changes its CLASSES in focus mode; GisMap stays mounted at the same position. */}
          <div className={focusMap ? "fixed inset-0 z-[1000] bg-[#0D1117] overflow-hidden" : "h-[72vh] md:h-auto md:flex-1 min-h-[300px] relative overflow-hidden bg-dot-grid"} data-testid="map-workspace" data-focus={focusMap}>
            <GisMap
              scene={activeScene}
              detection={detection}
              drift={drift}
              forward={forward}
              environment={environment}
              attribution={attribution}
              selectedVessel={selectedVessel}
              onSelectVessel={handleSelectVessel}
              onDownloadReport={handleDownloadReport}
              reportEnabled={!reportDisabledReason}
              reportDisabledReason={reportDisabledReason}
              focusMode={focusMap}
              onToggleFocus={toggleFocus}
            />
            {focusMap && (
              <>
                <div className="absolute right-3 top-3 z-[1100] flex flex-col gap-1.5" role="group" aria-label="Panels (collapsed while the map has focus)">
                  {([["scene", "Scene & run", Globe], ["spill", "Spill & env", Sparkles], ["candidates", "Candidates", Ship], ["analysis", "Analysis", BarChart3]] as const).map(([id, label, Icon]) => (
                    <button key={id} onClick={() => setDrawer((d) => (d === id ? null : id))} aria-pressed={drawer === id} data-testid={`drawer-${id}`}
                      title={`Open ${label} without leaving the map`}
                      className={`bg-[#161B22] hover:bg-[#21262D] border rounded-[4px] px-2.5 py-1.5 shadow-lg cursor-pointer text-[10px] font-mono flex items-center gap-1.5 ${drawer === id ? "border-[#58A6FF] text-[#79C0FF]" : "border-[#30363D] text-[#C9D1D9]"}`}>
                      <Icon className="w-3.5 h-3.5 text-[#58A6FF]" />{label}
                    </button>
                  ))}
                </div>
                {drawer && (
                  <div data-testid="focus-drawer"
                    className={`absolute z-[1200] bg-[#0D1117] border border-[#30363D] shadow-2xl flex flex-col ${drawer === "analysis" ? "left-0 right-0 bottom-0 h-[58vh] border-x-0 border-b-0" : "top-0 bottom-0 right-0 w-[min(30rem,94vw)] border-y-0 border-r-0"}`}>
                    <div className="h-9 shrink-0 px-3 flex items-center justify-between bg-[#161B22] border-b border-[#30363D]">
                      <span className="text-[11px] font-mono uppercase tracking-wider text-[#C9D1D9] flex items-center gap-1.5"><PanelRightOpen className="w-3.5 h-3.5 text-[#58A6FF]" />
                        {drawer === "scene" ? "Scene & run" : drawer === "spill" ? "Spill & environment" : drawer === "candidates" ? "Candidate vessels" : "Analysis"}</span>
                      <button onClick={() => setDrawer(null)} className="text-[#8B949E] hover:text-[#C9D1D9] cursor-pointer" aria-label="Close drawer" title="Close (Esc)"><X className="w-4 h-4" /></button>
                    </div>
                    <div className="flex-1 min-h-0 overflow-y-auto">
                      {drawer === "scene" && (
                        <>
                          <SceneSelector scenes={scenes} selectedSceneId={selectedSceneId} onSelectScene={handleSceneSelect} isAnalyzing={isAnalyzing} environment={environment} />
                          <WorkflowStepper nodeStatus={nodeStatus} isAnalyzing={isAnalyzing} onRunFullAnalysis={() => runFullAnalysis(selectedSceneId, driftParams, weights)} onReset={handleReset} />
                        </>
                      )}
                      {drawer === "spill" && <SpillCharacterizationPanel scene={activeScene} detection={detection} drift={drift} environment={environment} investigation={investigation} />}
                      {drawer === "candidates" && (
                        <CandidatePanel attribution={attribution} selectedVessel={selectedVessel} onSelectVessel={handleSelectVessel} onOpenWeights={() => setIsWeightsOpen(true)}
                          onCounterfactual={(mmsi) => runCounterfactual("exclude_vessel", mmsi)} counterfactualBusy={cfBusy || isAnalyzing} />
                      )}
                      {drawer === "analysis" && (
                        <IntelligenceDock investigation={investigation} events={events} nodeStatus={nodeStatus} isAnalyzing={isAnalyzing} forward={forward} backward={investigation?.state.backward ?? null}
                          environment={environment} attribution={attribution} selectedVessel={selectedVessel} counterfactuals={counterfactuals} counterfactualBusy={cfBusy} onRunSensitivity={() => runCounterfactual("forcing_sensitivity")} />
                      )}
                    </div>
                  </div>
                )}
                {(error || reportMsg) && (
                  <div className={`absolute left-1/2 -translate-x-1/2 bottom-3 z-[1300] px-3 py-1.5 rounded-[4px] text-[11px] font-mono border ${error ? "bg-[#2d1517] text-[#f85149] border-[#f85149]/40" : "bg-[#0d2238] text-[#79C0FF] border-[#58A6FF]/40"}`}>{error ?? reportMsg}</div>
                )}
              </>
            )}
          </div>
          <IntelligenceDock
            investigation={investigation}
            events={events}
            nodeStatus={nodeStatus}
            isAnalyzing={isAnalyzing}
            forward={forward}
            backward={investigation?.state.backward ?? null}
            environment={environment}
            attribution={attribution}
            selectedVessel={selectedVessel}
            counterfactuals={counterfactuals}
            counterfactualBusy={cfBusy}
            onRunSensitivity={() => runCounterfactual("forcing_sensitivity")}
          />
        </div>
        <SidePanel side="right" title="Candidate Vessels" icon={Ship} storageKey="aegis.panel.right" widthClass="w-full h-[50vh] md:h-full md:w-80 lg:w-[380px]">
          <CandidatePanel attribution={attribution} selectedVessel={selectedVessel} onSelectVessel={handleSelectVessel} onOpenWeights={() => setIsWeightsOpen(true)}
            onCounterfactual={(mmsi) => runCounterfactual("exclude_vessel", mmsi)} counterfactualBusy={cfBusy || isAnalyzing} />
        </SidePanel>
      </main>

      <footer className="h-[34px] bg-[#161B22] border-t border-[#30363D] px-5 flex items-center justify-between shrink-0 text-[11px] text-[#8B949E] font-mono z-20">
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${error ? "bg-[#f85149]" : isAnalyzing ? "bg-[#d29922] animate-pulse" : "bg-[#3fb950]"}`} />
            <span className="text-[#C9D1D9] font-semibold">{error ? "ERROR" : isAnalyzing ? "INVESTIGATION RUNNING" : investigation ? `INVESTIGATION ${investigation.investigation_id}` : "IDLE"}</span>
          </span>
          <span className="hidden sm:flex items-center gap-1.5"><Compass className="w-3.5 h-3.5 text-[#58A6FF]" /> EPSG:4326 (WGS84)</span>
        </div>
        <div className="flex items-center gap-4">
          {detection?.geometry?.centroid && <span className="hidden md:inline text-[#79C0FF]">CENTROID: {fmtLatLon(detection.geometry.centroid, 3)}</span>}
          <span className="flex items-center gap-1.5 text-[#C9D1D9]"><Clock className="w-3 h-3 text-[#8B949E]" />{currentTime}</span>
        </div>
      </footer>

      <WeightsModal isOpen={isWeightsOpen} onClose={() => setIsWeightsOpen(false)} weights={weights} onSave={handleWeightsSave} />
      <DriftSettingsModal isOpen={isDriftOpen} onClose={() => setIsDriftOpen(false)} driftParams={driftParams} onSave={handleDriftSave} currentAvailable={environment?.at_observation?.current_status !== "NOT_AVAILABLE"} />
      <MLDiagnosticsModal isOpen={isMLOpen} onClose={() => setIsMLOpen(false)} />
      <RealDataGuideModal isOpen={isRealGuideOpen} onClose={() => setIsRealGuideOpen(false)} />
      <TestRunnerModal isOpen={isTestsOpen} onClose={() => setIsTestsOpen(false)} />
    </div>
  );
}

export default App;
