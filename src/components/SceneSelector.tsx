import React from "react";
import { Globe, Wind, Waves, Thermometer, Calendar } from "lucide-react";
import type { Scene, EnvironmentState } from "../types";
import { fmt, statusColor } from "../lib/format";

interface SceneSelectorProps {
  scenes: Scene[];
  selectedSceneId: string;
  onSelectScene: (sceneId: string) => void;
  isAnalyzing: boolean;
  environment: EnvironmentState | null;
}

const Badge: React.FC<{ status: string }> = ({ status }) => (
  <span className="text-[9px] font-mono px-1 rounded border" style={{ color: statusColor(status), borderColor: statusColor(status) + "66" }}>{status}</span>
);

export const SceneSelector: React.FC<SceneSelectorProps> = ({ scenes, selectedSceneId, onSelectScene, isAnalyzing, environment }) => {
  const scene = scenes.find((s) => s.scene_id === selectedSceneId) || scenes[0];
  const at = environment?.at_observation;
  const e = scene?.environmental;
  // Prefer the investigation's sampled values (with provenance); fall back to the scene record.
  const windSpeed = at ? at.wind_speed_ms : e && e.wind_u10_ms !== null && e.wind_v10_ms !== null ? Math.hypot(e.wind_u10_ms, e.wind_v10_ms) : null;
  const windStatus = at?.wind_status ?? (scene?.synthetic ? "DEMO_CONSTANT" : e?.wind_u10_ms !== null ? "REAL" : "NOT_AVAILABLE");
  const curSpeed = at ? at.current_speed_ms : e && e.current_uo_ms !== null && e.current_vo_ms !== null ? Math.hypot(e.current_uo_ms, e.current_vo_ms) : null;
  const curStatus = at?.current_status ?? (curSpeed === null ? "NOT_AVAILABLE" : scene?.synthetic ? "DEMO_CONSTANT" : "REAL");
  return (
    <div className="bg-[#0D1117] border-b border-[#30363D] px-5 py-2 flex flex-col lg:flex-row lg:items-center justify-between gap-2.5 shrink-0 text-xs">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5 text-[#8B949E] font-medium">
          <Globe className="w-3.5 h-3.5 text-[#58A6FF]" />
          <span className="text-[11px] uppercase tracking-wider font-semibold">Active Scene:</span>
        </div>
        <select value={selectedSceneId} onChange={(ev) => onSelectScene(ev.target.value)} disabled={isAnalyzing}
          className="bg-[#161B22] border border-[#30363D] hover:border-[#58A6FF] rounded-[4px] px-2.5 py-1 text-[#C9D1D9] text-xs font-semibold focus:outline-none focus:ring-1 focus:ring-[#58A6FF] cursor-pointer">
          {scenes.map((sc) => <option key={sc.scene_id} value={sc.scene_id}>{sc.name} ({sc.region})</option>)}
        </select>
        {scene && (
          <div className="hidden sm:flex items-center gap-2 text-[11px] text-[#8B949E]">
            <span className="flex items-center gap-1 font-mono"><Calendar className="w-3 h-3 text-[#8B949E]" />{new Date(scene.acquisition_time).toISOString().replace("T", " ").slice(0, 19)} UTC</span>
            <span className="text-[#30363D]">•</span>
            <span className="text-[#79C0FF] font-mono">{scene.satellite} ({scene.polarization})</span>
            {scene.synthetic && <Badge status="SYNTHETIC_DEMO" />}
          </div>
        )}
      </div>
      {scene && (
        <div className="flex items-center gap-2.5 overflow-x-auto text-[11px] no-scrollbar">
          <div className="flex items-center gap-1.5 bg-[#161B22] border border-[#30363D] rounded-[4px] px-2.5 py-1 text-[#C9D1D9]" title={environment?.sources?.current?.label ?? ""}>
            <Waves className="w-3 h-3 text-[#79C0FF]" />
            <span className="text-[#8B949E] text-[10px] uppercase tracking-wider">Current:</span>
            <span className="font-mono font-semibold">{curSpeed === null ? "no product" : `${fmt(curSpeed)} m/s`}</span>
            <Badge status={curStatus} />
          </div>
          <div className="flex items-center gap-1.5 bg-[#161B22] border border-[#30363D] rounded-[4px] px-2.5 py-1 text-[#C9D1D9]" title={environment?.sources?.wind?.label ?? ""}>
            <Wind className="w-3 h-3 text-[#58A6FF]" />
            <span className="text-[#8B949E] text-[10px] uppercase tracking-wider">Wind 10m:</span>
            <span className="font-mono font-semibold">{windSpeed === null ? "n/a" : `${fmt(windSpeed, 1)} m/s`}</span>
            {at && <span className="text-[10px] font-mono text-[#8B949E]">from {fmt(at.wind_direction_from_deg, 0)}°</span>}
            <Badge status={windStatus} />
          </div>
          <div className="hidden md:flex items-center gap-1.5 bg-[#161B22] border border-[#30363D] rounded-[4px] px-2.5 py-1 text-[#C9D1D9]">
            <Thermometer className="w-3 h-3 text-[#AFF5B4]" />
            <span className="text-[#8B949E] text-[10px] uppercase tracking-wider">SST:</span>
            <span className="font-mono font-semibold">{e?.sea_temp_c === null || e?.sea_temp_c === undefined ? "no product" : `${e.sea_temp_c}°C`}</span>
            {(e?.sea_temp_c === null || e?.sea_temp_c === undefined) ? <Badge status="NOT_AVAILABLE" /> : scene.synthetic ? <Badge status="DEMO_CONSTANT" /> : null}
          </div>
        </div>
      )}
    </div>
  );
};
