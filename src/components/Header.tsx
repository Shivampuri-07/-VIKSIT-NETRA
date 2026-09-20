import React, { useEffect, useRef, useState } from "react";
import { Waves, Settings, BookOpen, Terminal, Activity, Cpu, Sliders, ChevronDown, CircleDot, Plus, RotateCcw } from "lucide-react";

/** Primary sections of the workbench. The map instance stays mounted across all of them. */
export type AppView = "overview" | "map" | "investigation" | "analytics" | "evidence" | "reports";

export const VIEWS: { id: AppView; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "map", label: "Map" },
  { id: "investigation", label: "Investigation" },
  { id: "analytics", label: "Analytics" },
  { id: "evidence", label: "Evidence" },
  { id: "reports", label: "Reports" },
];

interface HeaderProps {
  view: AppView;
  onViewChange: (v: AppView) => void;
  appMode: "DEMO" | "REAL";
  onToggleMode: (mode: "DEMO" | "REAL") => void;
  onOpenWeights: () => void;
  onOpenDriftSettings: () => void;
  onOpenMLDiagnostics: () => void;
  onOpenRealGuide: () => void;
  onOpenTests: () => void;
  isAnalyzing: boolean;
  hasError: boolean;
  onNewInvestigation: () => void;
  /** Public demonstration deployments pass this to offer a return to the clean starting state. */
  onResetDemo?: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  view,
  onViewChange,
  appMode,
  onToggleMode,
  onOpenWeights,
  onOpenDriftSettings,
  onOpenMLDiagnostics,
  onOpenRealGuide,
  onOpenTests,
  isAnalyzing,
  hasError,
  onNewInvestigation,
  onResetDemo,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const tools: { label: string; hint: string; icon: React.ElementType; onClick: () => void }[] = [
    { label: "Attribution weights", hint: "Adjust the four scoring factor weights", icon: Sliders, onClick: onOpenWeights },
    { label: "Drift parameters", hint: "Backtrack hours, particles, wind factor, diffusion", icon: Activity, onClick: onOpenDriftSettings },
    { label: "Segmentation model", hint: "U-Net registry, checkpoint and metrics", icon: Cpu, onClick: onOpenMLDiagnostics },
    { label: "Engine self-test", hint: "Run in-process engine checks", icon: Terminal, onClick: onOpenTests },
    { label: "Data source guide", hint: "Satellite, wind, current and AIS providers", icon: BookOpen, onClick: onOpenRealGuide },
  ];

  const statusTone = hasError ? "text-danger" : isAnalyzing ? "text-warn" : "text-ok";
  const statusText = hasError ? "Attention" : isAnalyzing ? "Running" : "Ready";

  return (
    <header className="bg-surface border-b border-line shrink-0 z-30 select-none">
      <div className="h-14 px-4 lg:px-5 flex items-center justify-between gap-4">
        {/* Brand */}
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-[8px] bg-navy flex items-center justify-center text-white shrink-0" aria-hidden="true">
            <Waves className="w-[18px] h-[18px]" />
          </div>
          <div className="leading-tight min-w-0">
            <div className="flex items-baseline gap-2">
              <span className="text-[15px] font-semibold tracking-tight text-navy truncate">VIKSIT-NETRA</span>
              <span className="hidden xl:inline text-[10px] text-faint vn-num">by Viksit Tech</span>
            </div>
            <div className="text-[10.5px] text-muted hidden sm:block truncate">Maritime Environmental Intelligence</div>
          </div>
          {/* Deployment label: says plainly that this is the demonstration dataset, not an operational feed. */}
          <div
            title="This deployment runs the preconfigured demonstration scenario on the project's bundled validated data."
            className="hidden sm:inline-flex items-center gap-1.5 rounded-full border border-saffron/40 bg-saffron-50 px-2 py-[2px] text-[10px] font-semibold text-saffron whitespace-nowrap shrink-0"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-saffron" aria-hidden="true" />
            DEMO MODE
          </div>
        </div>

        {/* Primary navigation */}
        <nav aria-label="Primary" className="flex-1 min-w-0 hidden md:flex justify-center">
          <div className="flex items-center gap-0.5 bg-subtle border border-line rounded-[10px] p-1 overflow-x-auto no-scrollbar">
            {VIEWS.map((v) => (
              <button
                key={v.id}
                onClick={() => onViewChange(v.id)}
                aria-current={view === v.id ? "page" : undefined}
                data-testid={`nav-${v.id}`}
                className={`px-3 py-1.5 rounded-[7px] text-[12.5px] font-medium whitespace-nowrap transition-colors cursor-pointer ${
                  view === v.id ? "bg-surface text-navy shadow-sm border border-line" : "text-muted hover:text-ink"
                }`}
              >
                {v.label}
              </button>
            ))}
          </div>
        </nav>

        {/* Status + mode + tools */}
        <div className="flex items-center gap-2 shrink-0">
          <span className={`hidden lg:flex items-center gap-1.5 text-[11px] font-medium ${statusTone}`} aria-live="polite">
            <CircleDot className={`w-3.5 h-3.5 ${isAnalyzing ? "animate-pulse" : ""}`} aria-hidden="true" />
            {statusText}
          </span>

          <button onClick={onNewInvestigation} className="vn-btn vn-btn-primary" data-testid="new-investigation" title="Start a new investigation: upload an image, connect data, or open an incident">
            <Plus className="w-3.5 h-3.5" aria-hidden="true" />
            <span className="hidden sm:inline">New</span>
          </button>

          <div className="hidden md:flex items-center rounded-[8px] border border-line p-0.5 bg-subtle" role="group" aria-label="Data mode">
            {(["REAL", "DEMO"] as const).map((m) => (
              <button
                key={m}
                onClick={() => onToggleMode(m)}
                aria-pressed={appMode === m}
                title={m === "REAL" ? "Real-data mode label" : "Demo-data mode label"}
                className={`px-2.5 py-1 rounded-[6px] text-[11px] font-semibold cursor-pointer transition-colors ${
                  appMode === m ? "bg-surface text-navy border border-line shadow-sm" : "text-muted hover:text-ink"
                }`}
              >
                <span className="hidden sm:inline">{m === "REAL" ? "Real data" : "Demo"}</span>
                <span className="sm:hidden">{m === "REAL" ? "Real" : "Demo"}</span>
              </button>
            ))}
          </div>

          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setMenuOpen((o) => !o)}
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              className="vn-btn"
              title="Settings, model registry, self-test and documentation"
            >
              <Settings className="w-3.5 h-3.5 text-navy-600" aria-hidden="true" />
              <span className="hidden lg:inline">Settings</span>
              <ChevronDown className="w-3 h-3 text-muted" aria-hidden="true" />
            </button>
            {menuOpen && (
              <div role="menu" className="absolute right-0 mt-1.5 w-[268px] vn-card p-1.5 z-50">
                {tools.map((t) => {
                  const Icon = t.icon;
                  return (
                    <button
                      key={t.label}
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        t.onClick();
                      }}
                      className="w-full text-left px-2.5 py-2 rounded-[8px] hover:bg-subtle flex items-start gap-2.5 cursor-pointer"
                    >
                      <Icon className="w-4 h-4 text-navy-600 mt-[1px] shrink-0" aria-hidden="true" />
                      <span className="min-w-0">
                        <span className="block text-[12.5px] font-medium text-ink">{t.label}</span>
                        <span className="block text-[11px] text-muted leading-snug">{t.hint}</span>
                      </span>
                    </button>
                  );
                })}
                {onResetDemo && (
                  <>
                    <div className="my-1.5 border-t border-line" />
                    <button
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        onResetDemo();
                      }}
                      data-testid="reset-demo"
                      className="w-full text-left px-2.5 py-2 rounded-[8px] hover:bg-subtle flex items-start gap-2.5 cursor-pointer"
                    >
                      <RotateCcw className="w-4 h-4 text-navy-600 mt-[1px] shrink-0" aria-hidden="true" />
                      <span className="min-w-0">
                        <span className="block text-[12.5px] font-medium text-ink">Reset demo</span>
                        <span className="block text-[11px] text-muted leading-snug">Clear all results and return to the start screen</span>
                      </span>
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Compact navigation for small screens */}
      <nav aria-label="Primary (compact)" className="md:hidden border-t border-line px-2 py-1.5 flex gap-1 overflow-x-auto no-scrollbar">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            onClick={() => onViewChange(v.id)}
            aria-current={view === v.id ? "page" : undefined}
            className={`px-3 py-1.5 rounded-[7px] text-[12px] font-medium whitespace-nowrap cursor-pointer ${
              view === v.id ? "bg-navy-50 text-navy border border-navy-600/20" : "text-muted"
            }`}
          >
            {v.label}
          </button>
        ))}
      </nav>
    </header>
  );
};
