import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Header, VIEWS, type AppView } from "./components/Header";
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
import { AgentWorkflowPanel } from "./components/AgentWorkflowPanel";
import { AnalyticsPanel } from "./components/AnalyticsPanel";
import { HypothesesPanel } from "./components/HypothesesPanel";
import { CounterfactualPanel } from "./components/CounterfactualPanel";
import { SidePanel } from "./components/SidePanel";
import { UploadModal } from "./components/UploadModal";
import { ConnectDataModal } from "./components/ConnectDataModal";
import { NewInvestigationModal } from "./components/NewInvestigationModal";
import { EvidenceSearch } from "./components/EvidenceSearch";
import { DemoLanding } from "./components/DemoLanding";
import { Card, Disclose, EmptyState, KV, StatusChip, Tag } from "./components/ui";
import {
  Scene, SpillDetection, DriftSimulation, CandidateRanking, VesselScoreDetail,
  InvestigationView, NodeEvent, NodeStatus, DriftResult, EnvironmentState, FactorWeights, DriftSettings,
} from "./types";
import { toLegacyDrift, toLegacyAttribution, envSummaryFromInvestigation } from "../server/lib/legacy";
import { startInvestigation, streamInvestigation, fetchInvestigation, rerunInvestigation } from "./lib/investigationClient";
import { fmt, fmtLatLon } from "./lib/format";
import { generateIncidentReport } from "./report/generateReport";
import {
  Compass, Clock, AlertTriangle, X, Sparkles, Ship, Globe, BarChart3, FileDown,
  Bot, Scale, FlaskConical, Database, CheckCircle2, Info, Search as SearchIcon, Satellite,
} from "lucide-react";

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
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [isConnectOpen, setIsConnectOpen] = useState(false);
  const [isNewOpen, setIsNewOpen] = useState(false);

  const [weights, setWeights] = useState<FactorWeights>({ spatial: 0.35, temporal: 0.25, trajectory: 0.25, consistency: 0.15 });
  const [driftParams, setDriftParams] = useState<DriftSettings>({
    driftHours: 12, numParticles: 300, windFactor: 0.03, eddyDiffusivity: 2.5, unknownCurrentSigma: 0.1,
  });
  const selectedMmsiRef = useRef<string | null>(null);
  const autoRanRef = useRef(false);

  /**
   * Public deployments open on the landing page and start the investigation on an explicit click,
   * so a reviewer always sees what is about to run. The flag is scoped to the browser TAB
   * (sessionStorage): a refresh keeps the workbench, a new tab or a new visitor starts clean and
   * never inherits another session's state. `?launch=1` skips the landing page for direct links.
   */
  const [launched, setLaunched] = useState<boolean>(() => {
    try {
      if (new URLSearchParams(window.location.search).get("launch") === "1") return true;
      return sessionStorage.getItem("vn.launched") === "1";
    } catch {
      return false;
    }
  });

  /** Active workbench section. The map instance stays mounted in every section. */
  const [view, setView] = useState<AppView>(() => {
    try {
      const v = new URLSearchParams(window.location.search).get("view");
      return VIEWS.some((x) => x.id === v) ? (v as AppView) : "map";
    } catch {
      return "map";
    }
  });

  // Focus map: the SAME map instance is enlarged (never remounted), so scene, layers, horizon and selection are preserved.
  const [focusMap, setFocusMap] = useState<boolean>(() => {
    try {
      return new URLSearchParams(window.location.search).get("focus") === "1";
    } catch {
      return false;
    }
  });
  const [drawer, setDrawer] = useState<"scene" | "spill" | "candidates" | "analysis" | null>(() => {
    try {
      const d = new URLSearchParams(window.location.search).get("drawer");
      return d === "scene" || d === "spill" || d === "candidates" || d === "analysis" ? d : null;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !focusMap) return;
      if (drawer) setDrawer(null);
      else setFocusMap(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusMap, drawer]);
  const toggleFocus = useCallback(() => {
    setFocusMap((f) => !f);
    setDrawer(null);
  }, []);

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

  const applyView = useCallback((v: InvestigationView) => {
    const s = v.state;
    setCounterfactuals([]); // results of the previous state are stale
    setInvestigation(v);
    setEvents(v.events);
    setNodeStatus(Object.fromEntries(v.graph.nodes.map((n) => [n.id, n.status])));
    setDetection(s.detection ?? null);
    setForward(s.forward ?? null);
    setEnvironment(s.environment ?? null);
    const env = envSummaryFromInvestigation(s.environment);
    if (s.backward && s.detection) {
      setDrift(toLegacyDrift(s.backward, { simulation_id: v.investigation_id, spill_id: s.detection.spill_id }, env, s.detection.geometry.orientation_deg, !!s.detection.real_data) as unknown as DriftSimulation);
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
    if (launched && scenes.length && !autoRanRef.current) {
      autoRanRef.current = true;
      runFullAnalysis(selectedSceneId, driftParams, weights);
    }
  }, [launched, scenes, selectedSceneId, driftParams, weights, runFullAnalysis]);

  /** An uploaded image became a scene on the server: pick it up and investigate it with the existing pipeline. */
  const handleInvestigateUpload = useCallback(async (sceneId: string) => {
    try {
      const d = await fetch("/api/scenes").then((r) => r.json());
      if (Array.isArray(d.scenes)) setScenes(d.scenes);
    } catch (e) {
      console.error("Could not refresh scenes:", e);
    }
    setSelectedSceneId(sceneId);
    selectedMmsiRef.current = null;
    setView("map");
    runFullAnalysis(sceneId, driftParams, weights);
  }, [driftParams, weights, runFullAnalysis]);

  const handleShowVessel = useCallback((mmsi: string) => {
    const c = attribution?.top_candidates?.find((x) => x.mmsi === mmsi) ?? null;
    if (c) { handleSelectVessel(c); setView("map"); }
  }, [attribution]);

  const handleSceneSelect = (id: string) => {
    setSelectedSceneId(id);
    selectedMmsiRef.current = null;
    runFullAnalysis(id, driftParams, weights);
  };

  const handleReset = () => {
    setDetection(null); setDrift(null); setForward(null); setEnvironment(null); setAttribution(null);
    setSelectedVessel(null); setInvestigation(null); setEvents([]); setNodeStatus({}); setError(null);
  };

  /** Enter the workbench from the landing page and start the preconfigured demo investigation. */
  const handleLaunchDemo = useCallback(() => {
    try { sessionStorage.setItem("vn.launched", "1"); } catch { /* private mode: in-memory only */ }
    setLaunched(true);
  }, []);

  /**
   * Return to the clean starting state. Clears every derived result and the tab-scoped launch flag,
   * so the next reviewer begins exactly where the previous one did. Server-side investigations are
   * per-request and are not shared between sessions.
   */
  const handleResetDemo = useCallback(() => {
    try { sessionStorage.removeItem("vn.launched"); } catch { /* ignore */ }
    autoRanRef.current = false;
    selectedMmsiRef.current = null;
    handleReset();
    setCounterfactuals([]);
    setSelectedSceneId(REAL_SCENE_ID);
    setView("map");
    setFocusMap(false);
    setDrawer(null);
    setWeights({ spatial: 0.35, temporal: 0.25, trajectory: 0.25, consistency: 0.15 });
    setDriftParams({ driftHours: 12, numParticles: 300, windFactor: 0.03, eddyDiffusivity: 2.5, unknownCurrentSigma: 0.1 });
    setLaunched(false);
    try { window.history.replaceState({}, "", window.location.pathname); } catch { /* ignore */ }
  }, []);

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
      setView("evidence");
    } catch (e) {
      setError(`Counterfactual failed: ${(e as Error).message}`);
    } finally {
      setCfBusy(false);
    }
  };

  const activeScene = scenes.find((s) => s.scene_id === selectedSceneId) ?? scenes[0] ?? null;

  /** The investigation finished but produced no candidates: say why, from the state itself. */
  const candidatesEmptyReason = useMemo(() => {
    if (attribution || !investigation || investigation.status === "running" || isAnalyzing) return null;
    const ais = investigation.state?.ais;
    if (ais && (ais.vessels ?? 0) === 0) {
      return `${ais.source}. No vessel tracks were available for this scene, so no candidate could be scored. Drift and spill geometry are still available.`;
    }
    return "Vessel attribution did not run for this investigation.";
  }, [attribution, investigation, isAnalyzing]);

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

  // ---------------------------------------------------------------- derived summary (existing state only)
  const summary = useMemo(() => {
    const snaps = forward?.snapshots ?? [];
    return {
      longest: snaps.length ? snaps[snaps.length - 1] : null,
      unsupported: snaps.filter((s) => s.forcing_support?.supported === false).length,
      nSnaps: snaps.length,
      topLeads: attribution?.top_candidates?.slice(0, 3) ?? [],
    };
  }, [forward, attribution]);

  const mapWrapperClass = focusMap
    ? "fixed inset-0 z-[1000] bg-canvas overflow-hidden"
    : view === "map"
      ? "h-[58vh] min-h-[340px] md:h-auto md:flex-1 relative overflow-hidden vn-card m-3"
      : view === "overview"
        ? "h-[46vh] min-h-[320px] relative overflow-hidden vn-card mx-3 mb-3"
        : "hidden";

  const sectionWrap = "flex-1 min-h-0 overflow-y-auto p-3";

  if (!launched) return <DemoLanding onLaunch={handleLaunchDemo} />;

  return (
    <div className="flex flex-col min-h-screen w-full md:h-screen md:w-full bg-canvas text-ink font-sans antialiased overflow-x-hidden md:overflow-hidden">
      <Header
        onResetDemo={handleResetDemo}
        view={view}
        onViewChange={setView}
        appMode={appMode}
        onToggleMode={handleModeToggle}
        onOpenWeights={() => setIsWeightsOpen(true)}
        onOpenDriftSettings={() => setIsDriftOpen(true)}
        onOpenMLDiagnostics={() => setIsMLOpen(true)}
        onOpenRealGuide={() => setIsRealGuideOpen(true)}
        onOpenTests={() => setIsTestsOpen(true)}
        isAnalyzing={isAnalyzing}
        hasError={!!error}
        onNewInvestigation={() => setIsNewOpen(true)}
      />
      <SceneSelector scenes={scenes} selectedSceneId={selectedSceneId} onSelectScene={handleSceneSelect} isAnalyzing={isAnalyzing} environment={environment} />
      <WorkflowStepper
        nodeStatus={nodeStatus}
        isAnalyzing={isAnalyzing}
        onRunFullAnalysis={() => runFullAnalysis(selectedSceneId, driftParams, weights)}
        onReset={handleReset}
      />

      {(error || reportMsg) && (
        <div
          role="status"
          className={`px-4 lg:px-5 py-2 text-[12px] flex items-center justify-between gap-3 border-b ${
            error ? "bg-danger-50 text-danger border-danger/25" : "bg-navy-50 text-navy-600 border-navy-600/20"
          }`}
        >
          <span className="flex items-center gap-2 min-w-0">
            {error ? <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" /> : <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />}
            <span className="truncate">{error ?? reportMsg}</span>
          </span>
          <button onClick={() => { setError(null); setReportMsg(null); }} aria-label="Dismiss message" className="cursor-pointer shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <main className="md:flex-1 flex flex-col md:flex-row md:overflow-hidden relative md:min-h-0 min-w-0">
        {view === "map" && (
          <div className="hidden md:flex h-full shrink-0">
            <SidePanel side="left" title="Incident overview" icon={Sparkles} storageKey="aegis.panel.left" widthClass="md:w-[21rem] lg:w-[23rem]">
              <SpillCharacterizationPanel scene={activeScene} detection={detection} drift={drift} environment={environment} investigation={investigation} />
            </SidePanel>
          </div>
        )}

        <div className="md:flex-1 flex flex-col min-w-0 md:min-h-0">
          {/* ---------- Overview digest: five questions answered from the current state ---------- */}
          {view === "overview" && (
            <div className="p-3 pb-0 grid grid-cols-2 lg:grid-cols-5 gap-3">
              <Card bodyClassName="p-3.5">
                <div className="vn-label">Spill detected</div>
                {detection?.geometry?.has_detection ? (
                  <>
                    <div className="text-[16px] font-semibold text-ink mt-1 leading-tight">Yes</div>
                    <StatusChip status={detection.geometry_source} className="mt-1.5" />
                  </>
                ) : (
                  <div className="text-[14px] text-muted mt-1">{investigation ? "No slick geometry" : "Not run"}</div>
                )}
              </Card>

              <Card bodyClassName="p-3.5">
                <div className="vn-label">Observed area</div>
                <div className="text-[20px] font-semibold text-ink vn-num mt-1 leading-tight">
                  {detection?.geometry ? fmt(detection.geometry.area_km2) : "—"}
                  {detection?.geometry && <span className="text-[12px] text-muted font-normal"> km²</span>}
                </div>
                <div className="text-[11px] text-muted mt-0.5">
                  {detection?.geometry ? `${fmt(detection.geometry.perimeter_km, 1)} km perimeter` : "Run the investigation"}
                </div>
              </Card>

              <Card bodyClassName="p-3.5">
                <div className="vn-label">Probable origin</div>
                {drift?.probable_origin ? (
                  <>
                    <div className="text-[13px] font-medium text-navy vn-num mt-1 leading-tight">{fmtLatLon(drift.probable_origin.centroid, 2)}</div>
                    <div className="text-[11px] text-muted mt-0.5">
                      P90 {fmt(drift.probable_origin.uncertainty_radius_km)} km · T−{fmt(drift.simulation_duration_hours, 0)} h
                    </div>
                  </>
                ) : (
                  <div className="text-[14px] text-muted mt-1">—</div>
                )}
              </Card>

              <Card bodyClassName="p-3.5">
                <div className="vn-label">Forecast</div>
                {summary.longest ? (
                  <>
                    <div className="text-[16px] font-semibold text-ink vn-num mt-1 leading-tight">T+{summary.longest.hours} h</div>
                    <div className="text-[11px] text-muted mt-0.5">P90 envelope {fmt(summary.longest.hull_area_km2, 0)} km²</div>
                    {summary.unsupported > 0 && (
                      <Tag tone="warn" className="mt-1.5" title="Real forcing coverage does not support these horizons as forecasts">
                        {summary.unsupported}/{summary.nSnaps} scenario only
                      </Tag>
                    )}
                  </>
                ) : (
                  <div className="text-[14px] text-muted mt-1">—</div>
                )}
              </Card>

              <Card bodyClassName="p-3.5">
                <div className="vn-label">Investigative leads</div>
                {attribution ? (
                  <>
                    <div className="text-[20px] font-semibold text-danger vn-num mt-1 leading-tight">{attribution.high_priority_count}</div>
                    <div className="text-[11px] text-muted mt-0.5">high priority of {attribution.total_candidates} scored</div>
                  </>
                ) : (
                  <div className="text-[14px] text-muted mt-1">—</div>
                )}
              </Card>
            </div>
          )}

          {view === "overview" && summary.topLeads.length > 0 && (
            <div className="px-3 pt-3">
              <Card
                title="Top investigative leads"
                subtitle="Ranked by compatibility with the observed slick and the backtracked corridor — not proof of causation."
                icon={Ship}
                bodyClassName="p-0"
              >
                <ul className="divide-y divide-line">
                  {summary.topLeads.map((c) => (
                    <li key={c.mmsi}>
                      <button
                        onClick={() => { handleSelectVessel(c); setView("map"); }}
                        className="w-full text-left px-4 py-2.5 hover:bg-subtle flex items-center justify-between gap-3 cursor-pointer"
                      >
                        <span className="flex items-center gap-2.5 min-w-0">
                          <span className="text-[11px] text-muted vn-num">#{c.rank}</span>
                          <span className="text-[13px] font-medium text-ink truncate">{c.vessel_name}</span>
                          <span className="text-[11px] text-muted vn-num hidden sm:inline">MMSI {c.mmsi}</span>
                        </span>
                        <span className="flex items-center gap-2.5 shrink-0">
                          <span className="text-[11px] text-muted vn-num hidden md:inline">{fmt(c.metrics.min_distance_to_slick_km ?? null, 1)} km to slick</span>
                          <span className="text-[13px] font-semibold vn-num text-ink">{c.composite_score.toFixed(3)}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
          )}

          {/* ---------- The map: always mounted; resized or hidden per view ---------- */}
          <div className={mapWrapperClass} data-testid="map-workspace" data-focus={focusMap} data-view={view}>
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
                  {([["scene", "Scene & run", Globe], ["spill", "Incident", Sparkles], ["candidates", "Candidates", Ship], ["analysis", "Analysis", BarChart3]] as const).map(([id, label, Icon]) => (
                    <button
                      key={id}
                      onClick={() => setDrawer((d) => (d === id ? null : id))}
                      aria-pressed={drawer === id}
                      data-testid={`drawer-${id}`}
                      title={`Open ${label} without leaving the map`}
                      className={`vn-float px-2.5 py-1.5 text-[12px] font-medium flex items-center gap-1.5 cursor-pointer ${drawer === id ? "text-navy border-navy-600/40" : "text-ink"}`}
                    >
                      <Icon className="w-3.5 h-3.5 text-navy-600" aria-hidden="true" />
                      {label}
                    </button>
                  ))}
                </div>
                {drawer && (
                  <div
                    data-testid="focus-drawer"
                    className={`absolute z-[1200] bg-canvas border-line shadow-xl flex flex-col ${
                      drawer === "analysis" ? "left-0 right-0 bottom-0 h-[58vh] border-t" : "top-0 bottom-0 right-0 w-[min(30rem,94vw)] border-l"
                    }`}
                  >
                    <div className="h-10 shrink-0 px-3 flex items-center justify-between bg-surface border-b border-line">
                      <span className="text-[12.5px] font-semibold text-ink">
                        {drawer === "scene" ? "Scene & run" : drawer === "spill" ? "Incident overview" : drawer === "candidates" ? "Candidate vessels" : "Analysis"}
                      </span>
                      <button onClick={() => setDrawer(null)} className="text-muted hover:text-ink cursor-pointer" aria-label="Close drawer" title="Close (Esc)">
                        <X className="w-4 h-4" />
                      </button>
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
                          onCounterfactual={(mmsi) => runCounterfactual("exclude_vessel", mmsi)} counterfactualBusy={cfBusy || isAnalyzing} emptyReason={candidatesEmptyReason} />
                      )}
                      {drawer === "analysis" && (
                        <AnalyticsPanel forward={forward} backward={investigation?.state.backward ?? null} environment={environment} attribution={attribution} selectedVessel={selectedVessel} />
                      )}
                    </div>
                  </div>
                )}
                {(error || reportMsg) && (
                  <div className={`absolute left-1/2 -translate-x-1/2 bottom-3 z-[1300] vn-float px-3 py-1.5 text-[12px] ${error ? "text-danger" : "text-navy-600"}`}>
                    {error ?? reportMsg}
                  </div>
                )}
              </>
            )}
          </div>

          {/* ---------- Sections (the map is hidden in these) ---------- */}
          {view === "investigation" && (
            <div className={sectionWrap}>
              <div className="grid grid-cols-1 gap-3">
                <Card
                  title="Investigation agents"
                  subtitle="Twelve rule-based nodes with their evidence, timings and provenance. No language model is involved."
                  icon={Bot}
                  bodyClassName="p-0 h-[420px]"
                >
                  <AgentWorkflowPanel investigation={investigation} events={events} nodeStatus={nodeStatus} isAnalyzing={isAnalyzing} />
                </Card>
                <Card
                  title="Competing hypotheses, uncertainty and risk"
                  subtitle="Evidence balance is a transparent heuristic, not a probability."
                  icon={Scale}
                  bodyClassName="p-0"
                >
                  <HypothesesPanel investigation={investigation} />
                </Card>
              </div>
            </div>
          )}

          {view === "analytics" && (
            <div className={sectionWrap}>
              <Card title="Analytics" subtitle="Charts derived from the current investigation state only." icon={BarChart3} bodyClassName="p-0 min-h-[420px]">
                <AnalyticsPanel forward={forward} backward={investigation?.state.backward ?? null} environment={environment} attribution={attribution} selectedVessel={selectedVessel} />
              </Card>
            </div>
          )}

          {view === "evidence" && (
            <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
              <Card
                title="Ask about this investigation"
                subtitle="Deterministic search over the evidence this investigation already produced. No language model; no value is invented."
                icon={SearchIcon}
                bodyClassName="p-0"
              >
                <EvidenceSearch investigation={investigation} onShowVessel={handleShowVessel} />
              </Card>
              <div className="vn-card overflow-hidden h-[min(70vh,46rem)]">
                <CandidatePanel
                  attribution={attribution}
                  selectedVessel={selectedVessel}
                  onSelectVessel={handleSelectVessel}
                  onOpenWeights={() => setIsWeightsOpen(true)}
                  onCounterfactual={(mmsi) => runCounterfactual("exclude_vessel", mmsi)}
                  counterfactualBusy={cfBusy || isAnalyzing}
                  emptyReason={candidatesEmptyReason}
                  layout="wide"
                />
              </div>
              <Card
                title="Counterfactual analysis"
                subtitle="Analytical scenarios computed with the same engines — not observations or historical facts."
                icon={FlaskConical}
                bodyClassName="p-0 min-h-[220px]"
              >
                <CounterfactualPanel
                  results={counterfactuals}
                  busy={cfBusy}
                  canRun={!!investigation && investigation.status === "completed" && !isAnalyzing}
                  onRunSensitivity={() => runCounterfactual("forcing_sensitivity")}
                />
              </Card>
            </div>
          )}

          {view === "reports" && (
            <div className={sectionWrap}>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 items-start">
                <Card title="Incident report" subtitle="Colour-coded PDF built from the current investigation state and your viewer selections." icon={FileDown}>
                  <p className="text-[12px] text-muted leading-relaxed">
                    Includes scene metadata, model-run provenance, measured and stored segmentation metrics, environmental provenance, backtrack,
                    forward scenarios, origin zone, candidates, evidence, uncertainty, hypotheses, counterfactuals, orchestrator status and the
                    limitations of this analysis.
                  </p>
                  <button
                    onClick={() => handleDownloadReport({ horizon: "ALL" })}
                    disabled={!!reportDisabledReason}
                    className="vn-btn vn-btn-primary mt-3"
                    title={reportDisabledReason ?? "Download the PDF incident report"}
                  >
                    <FileDown className="w-4 h-4" aria-hidden="true" />
                    {reportBusy ? "Generating…" : "Download PDF report"}
                  </button>
                  {reportDisabledReason && <p className="text-[11px] text-muted mt-2">{reportDisabledReason}.</p>}
                  <p className="text-[11px] text-muted mt-3 leading-relaxed">
                    Every page carries the non-legal-proof notice. The report states what was measured and what was not assessed.
                  </p>
                </Card>

                <Card title="Data sources and provenance" subtitle="What this investigation actually consumed." icon={Database}>
                  {investigation ? (
                    <div className="space-y-0">
                      <KV k="Scene" v={activeScene?.name ?? "n/a"} mono={false} />
                      <KV k="Satellite / polarisation" v={`${activeScene?.satellite ?? "n/a"} · ${activeScene?.polarization ?? "n/a"}`} />
                      <KV k="Slick outline" v={<StatusChip status={detection?.geometry_source} />} mono={false} />
                      <KV k="Wind product" v={environment?.sources?.wind?.label ?? "n/a"} mono={false} />
                      <KV k="Current product" v={environment?.sources?.current?.label ?? "n/a"} mono={false} />
                      <KV k="AIS source" v={investigation.state.ais?.source ?? "n/a"} mono={false} />
                      <KV k="AIS records / vessels" v={`${investigation.state.ais?.records ?? 0} / ${investigation.state.ais?.vessels ?? 0}`} />
                      <KV k="Orchestrator" v={investigation.graph.orchestrator_status ?? investigation.graph.runtime} />
                      <KV k="Investigation ID" v={investigation.investigation_id} />
                    </div>
                  ) : (
                    <EmptyState title="No investigation yet" hint="Run an investigation to list its data sources." />
                  )}
                  <Disclose summary="Open the data source guide" className="mt-3">
                    <p className="text-[11px] text-muted leading-relaxed mb-2">Provider details for satellite, wind, current and AIS data.</p>
                    <button onClick={() => setIsRealGuideOpen(true)} className="vn-btn">
                      <Info className="w-3.5 h-3.5 text-navy-600" aria-hidden="true" />
                      Open guide
                    </button>
                  </Disclose>
                </Card>

                <Card title="System status" subtitle="Model registry, engine self-test and analysis parameters." icon={CheckCircle2}>
                  <div className="flex flex-wrap gap-2">
                    <button onClick={() => setIsMLOpen(true)} className="vn-btn">Segmentation model registry</button>
                    <button onClick={() => setIsTestsOpen(true)} className="vn-btn">Run engine self-test</button>
                    <button onClick={() => setIsDriftOpen(true)} className="vn-btn">Drift parameters</button>
                    <button onClick={() => setIsWeightsOpen(true)} className="vn-btn">Attribution weights</button>
                    <button onClick={() => setIsUploadOpen(true)} className="vn-btn"><Satellite className="w-3.5 h-3.5 text-navy-600" aria-hidden="true" />Upload SAR image</button>
                  </div>
                </Card>
              </div>
            </div>
          )}
        </div>

        {view === "map" && (
          <SidePanel side="right" title="Candidate vessels" icon={Ship} storageKey="aegis.panel.right" widthClass="w-full h-[50vh] md:h-full md:w-[22rem] lg:w-[25rem]">
            <CandidatePanel
              attribution={attribution}
              selectedVessel={selectedVessel}
              onSelectVessel={handleSelectVessel}
              onOpenWeights={() => setIsWeightsOpen(true)}
              onCounterfactual={(mmsi) => runCounterfactual("exclude_vessel", mmsi)}
              counterfactualBusy={cfBusy || isAnalyzing}
              emptyReason={candidatesEmptyReason}
            />
          </SidePanel>
        )}
      </main>

      <footer className="h-9 bg-surface border-t border-line px-4 lg:px-5 flex items-center justify-between shrink-0 text-[11px] text-muted z-20">
        <div className="flex items-center gap-4 min-w-0">
          <span className="flex items-center gap-2 min-w-0">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${error ? "bg-danger" : isAnalyzing ? "bg-warn animate-pulse" : "bg-ok"}`} aria-hidden="true" />
            <span className="text-ink-soft font-medium truncate">
              {error ? "Error" : isAnalyzing ? "Investigation running" : investigation ? `Investigation ${investigation.investigation_id}` : "Idle"}
            </span>
          </span>
          <span className="hidden sm:flex items-center gap-1.5">
            <Compass className="w-3.5 h-3.5 text-muted" aria-hidden="true" /> EPSG:4326 (WGS84)
          </span>
        </div>
        <div className="flex items-center gap-4 shrink-0">
          {detection?.geometry?.centroid && <span className="hidden md:inline vn-num">Centroid {fmtLatLon(detection.geometry.centroid, 3)}</span>}
          <span className="flex items-center gap-1.5 vn-num">
            <Clock className="w-3 h-3" aria-hidden="true" />
            {currentTime}
          </span>
        </div>
      </footer>

      <WeightsModal isOpen={isWeightsOpen} onClose={() => setIsWeightsOpen(false)} weights={weights} onSave={handleWeightsSave} />
      <DriftSettingsModal isOpen={isDriftOpen} onClose={() => setIsDriftOpen(false)} driftParams={driftParams} onSave={handleDriftSave} currentAvailable={environment?.at_observation?.current_status !== "NOT_AVAILABLE"} />
      <MLDiagnosticsModal isOpen={isMLOpen} onClose={() => setIsMLOpen(false)} />
      <RealDataGuideModal isOpen={isRealGuideOpen} onClose={() => setIsRealGuideOpen(false)} />
      <TestRunnerModal isOpen={isTestsOpen} onClose={() => setIsTestsOpen(false)} />
      <UploadModal isOpen={isUploadOpen} onClose={() => setIsUploadOpen(false)} onInvestigate={handleInvestigateUpload} busy={isAnalyzing} />
      <ConnectDataModal isOpen={isConnectOpen} onClose={() => setIsConnectOpen(false)} onOpenSarUpload={() => setIsUploadOpen(true)} />
      <NewInvestigationModal
        isOpen={isNewOpen}
        onClose={() => setIsNewOpen(false)}
        scenes={scenes}
        selectedSceneId={selectedSceneId}
        onOpenUpload={() => setIsUploadOpen(true)}
        onOpenConnect={() => setIsConnectOpen(true)}
        onOpenScene={handleSceneSelect}
        isAnalyzing={isAnalyzing}
      />
    </div>
  );
}

export default App;
