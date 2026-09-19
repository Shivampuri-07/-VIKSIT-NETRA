import React from "react";
import { Satellite, ShieldAlert, Cpu, Settings, BookOpen, Terminal, Activity, Layers } from "lucide-react";

interface HeaderProps {
  appMode: "DEMO" | "REAL";
  onToggleMode: (mode: "DEMO" | "REAL") => void;
  onOpenWeights: () => void;
  onOpenDriftSettings: () => void;
  onOpenMLDiagnostics: () => void;
  onOpenRealGuide: () => void;
  onOpenTests: () => void;
  isAnalyzing: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  appMode,
  onToggleMode,
  onOpenWeights,
  onOpenDriftSettings,
  onOpenMLDiagnostics,
  onOpenRealGuide,
  onOpenTests,
  isAnalyzing
}) => {
  return (
    <header className="h-[60px] bg-[#161B22] border-b border-[#30363D] px-5 flex items-center justify-between shrink-0 z-30 select-none">
      {/* Brand & System Title */}
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-[4px] bg-[#58A6FF]/10 border border-[#58A6FF]/30 flex items-center justify-center text-[#58A6FF]">
          <Layers className="w-4 h-4" />
        </div>
        <div className="flex items-center gap-3">
          <h1 className="font-semibold text-[#C9D1D9] text-sm md:text-[15px] tracking-tight flex items-center gap-2">
            <span>AEGIS</span>
            <span className="text-[#8B949E] font-normal">|</span>
            <span className="font-medium text-[#C9D1D9]">Sentinel-1 Oil Spill Attribution</span>
          </h1>
          <div className="hidden lg:flex items-center gap-2">
            <span className="px-2 py-0.5 rounded-[4px] text-[10px] uppercase font-mono tracking-wider bg-[#58A6FF]/10 text-[#58A6FF] border border-[#58A6FF]/30">
              SAR + Lagrangian + AIS
            </span>
            <span className="text-[#8B949E] text-[11px] font-mono">v1.2.4</span>
          </div>
        </div>
      </div>

      {/* Mode Switcher & Tools */}
      <div className="flex items-center gap-2.5">
        {/* Mode Selector */}
        <div className="bg-[#0D1117] border border-[#30363D] rounded-[4px] p-0.5 flex items-center text-xs">
          <button
            onClick={() => onToggleMode("DEMO")}
            className={`px-2.5 py-1 rounded-[3px] font-mono text-[11px] font-medium transition-colors ${
              appMode === "DEMO"
                ? "bg-[#58A6FF] text-white shadow-sm font-semibold"
                : "text-[#8B949E] hover:text-[#C9D1D9]"
            }`}
          >
            DEMO MODE
          </button>
          <button
            onClick={() => onToggleMode("REAL")}
            className={`px-2.5 py-1 rounded-[3px] font-mono text-[11px] font-medium transition-colors ${
              appMode === "REAL"
                ? "bg-[#d29922] text-white shadow-sm font-semibold"
                : "text-[#8B949E] hover:text-[#C9D1D9]"
            }`}
          >
            REAL DATA
          </button>
        </div>

        {/* Geometric Action Buttons */}
        <button
          onClick={onOpenWeights}
          title="Attribution Weights Config"
          className="px-2.5 py-1.5 rounded-[4px] bg-[#161B22] hover:bg-[#21262D] border border-[#30363D] hover:border-[#8B949E] text-[#C9D1D9] text-xs flex items-center gap-1.5 transition-colors cursor-pointer"
        >
          <Settings className="w-3.5 h-3.5 text-[#58A6FF]" />
          <span className="hidden md:inline font-mono text-[11px]">Weights</span>
        </button>

        <button
          onClick={onOpenDriftSettings}
          title="Drift Physics Parameters"
          className="px-2.5 py-1.5 rounded-[4px] bg-[#161B22] hover:bg-[#21262D] border border-[#30363D] hover:border-[#8B949E] text-[#C9D1D9] text-xs flex items-center gap-1.5 transition-colors cursor-pointer"
        >
          <Activity className="w-3.5 h-3.5 text-[#79C0FF]" />
          <span className="hidden md:inline font-mono text-[11px]">Drift</span>
        </button>

        <button
          onClick={onOpenMLDiagnostics}
          title="U-Net model registry and metrics"
          className="px-2.5 py-1.5 rounded-[4px] bg-[#161B22] hover:bg-[#21262D] border border-[#30363D] hover:border-[#8B949E] text-[#C9D1D9] text-xs flex items-center gap-1.5 transition-colors cursor-pointer"
        >
          <Cpu className="w-3.5 h-3.5 text-[#bc8cff]" />
          <span className="hidden md:inline font-mono text-[11px]">U-Net</span>
        </button>

        <button
          onClick={onOpenTests}
          title="Run engine self-test (in-process checks)"
          className="px-2.5 py-1.5 rounded-[4px] bg-[#161B22] hover:bg-[#21262D] border border-[#30363D] hover:border-[#8B949E] text-[#C9D1D9] text-xs flex items-center gap-1.5 transition-colors cursor-pointer"
        >
          <Terminal className="w-3.5 h-3.5 text-[#AFF5B4]" />
          <span className="hidden md:inline font-mono text-[11px]">Tests</span>
        </button>

        <button
          onClick={onOpenRealGuide}
          title="Copernicus & AIS Setup Documentation"
          className="px-2.5 py-1.5 rounded-[4px] bg-[#161B22] hover:bg-[#21262D] border border-[#30363D] hover:border-[#8B949E] text-[#C9D1D9] text-xs flex items-center gap-1.5 transition-colors cursor-pointer"
        >
          <BookOpen className="w-3.5 h-3.5 text-[#d29922]" />
          <span className="hidden md:inline font-mono text-[11px]">Docs</span>
        </button>
      </div>
    </header>
  );
};

