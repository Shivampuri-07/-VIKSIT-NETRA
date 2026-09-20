import React from "react";
import { Wind, Waves, Thermometer, Satellite, MapPin, ChevronDown } from "lucide-react";
import type { Scene, EnvironmentState } from "../types";
import { fmt } from "../lib/format";
import { StatusChip } from "./ui";

interface SceneSelectorProps {
  scenes: Scene[];
  selectedSceneId: string;
  onSelectScene: (sceneId: string) => void;
  isAnalyzing: boolean;
  environment: EnvironmentState | null;
}

/** One compact environment reading with its provenance. */
const Reading: React.FC<{
  icon: React.ElementType;
  label: string;
  value: string;
  extra?: string;
  status?: string | null;
  title?: string;
}> = ({ icon: Icon, label, value, extra, status, title }) => (
  <div className="flex items-center gap-2 px-3 py-1.5 rounded-[9px] border border-line bg-surface" title={title}>
    <Icon className="w-3.5 h-3.5 text-navy-600 shrink-0" aria-hidden="true" />
    <div className="leading-tight min-w-0">
      <div className="vn-label">{label}</div>
      <div className="text-[12px] text-ink vn-num whitespace-nowrap">
        {value}
        {extra && <span className="text-muted font-normal"> {extra}</span>}
      </div>
    </div>
    {status && <StatusChip status={status} />}
  </div>
);

/**
 * Incident context bar: which scene is under investigation, when it was observed and what the
 * environment was, each value carrying its provenance. Values come from the investigation's
 * sampled environment when available, otherwise from the scene record.
 */
export const SceneSelector: React.FC<SceneSelectorProps> = ({ scenes, selectedSceneId, onSelectScene, isAnalyzing, environment }) => {
  const scene = scenes.find((s) => s.scene_id === selectedSceneId) || scenes[0];
  const at = environment?.at_observation;
  const e = scene?.environmental;

  const windSpeed = at ? at.wind_speed_ms : e && e.wind_u10_ms !== null && e.wind_v10_ms !== null ? Math.hypot(e.wind_u10_ms, e.wind_v10_ms) : null;
  const windStatus = at?.wind_status ?? (scene?.synthetic ? "DEMO_CONSTANT" : e?.wind_u10_ms !== null ? "REAL" : "NOT_AVAILABLE");
  const curSpeed = at ? at.current_speed_ms : e && e.current_uo_ms !== null && e.current_vo_ms !== null ? Math.hypot(e.current_uo_ms, e.current_vo_ms) : null;
  const curStatus = at?.current_status ?? (curSpeed === null ? "NOT_AVAILABLE" : scene?.synthetic ? "DEMO_CONSTANT" : "REAL");
  const sst = e?.sea_temp_c;

  const acq = scene ? new Date(scene.acquisition_time) : null;
  const acqDate = acq && !Number.isNaN(acq.getTime()) ? acq.toISOString().slice(0, 10) : "n/a";
  const acqTime = acq && !Number.isNaN(acq.getTime()) ? acq.toISOString().slice(11, 16) : "--:--";

  return (
    <div className="bg-surface border-b border-line px-4 lg:px-5 py-2.5 shrink-0">
      <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-3">
        {/* Active incident */}
        <div className="flex items-center gap-3 min-w-0">
          <div className="shrink-0">
            <div className="vn-label">Active incident</div>
            <div className="relative mt-0.5">
              <select
                value={selectedSceneId}
                onChange={(ev) => onSelectScene(ev.target.value)}
                disabled={isAnalyzing}
                aria-label="Select incident scene"
                className="appearance-none bg-surface border border-line-strong hover:border-muted rounded-[8px] pl-2.5 pr-7 py-1.5 text-[13px] font-semibold text-ink cursor-pointer disabled:opacity-60 max-w-[min(58vw,26rem)] truncate"
              >
                {scenes.map((sc) => (
                  <option key={sc.scene_id} value={sc.scene_id}>
                    {sc.name}
                  </option>
                ))}
              </select>
              <ChevronDown className="w-3.5 h-3.5 text-muted absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden="true" />
            </div>
          </div>

          {scene && (
            <div className="hidden sm:flex items-center gap-x-4 gap-y-1 flex-wrap text-[11.5px] text-muted pl-3 border-l border-line">
              <span className="flex items-center gap-1.5">
                <MapPin className="w-3.5 h-3.5 text-muted" aria-hidden="true" />
                {scene.region}
              </span>
              <span className="vn-num text-ink-soft">
                {acqDate} · {acqTime} UTC
              </span>
              <span className="flex items-center gap-1.5">
                <Satellite className="w-3.5 h-3.5 text-muted" aria-hidden="true" />
                <span className="text-ink-soft">
                  {scene.satellite} · {scene.polarization}
                </span>
              </span>
              <StatusChip status={scene.synthetic ? "SYNTHETIC_DEMO" : "REAL"} title={scene.data_source ?? undefined} />
            </div>
          )}
        </div>

        {/* Environment readings */}
        {scene && (
          <div className="flex items-center gap-2 flex-wrap xl:justify-end">
            <Reading
              icon={Wind}
              label="Wind 10 m"
              value={windSpeed === null ? "Not available" : `${fmt(windSpeed, 1)} m/s`}
              extra={at ? `from ${fmt(at.wind_direction_from_deg, 0)}°` : undefined}
              status={windStatus}
              title={environment?.sources?.wind?.label ?? undefined}
            />
            <Reading
              icon={Waves}
              label="Surface current"
              value={curSpeed === null ? "Not assessed" : `${fmt(curSpeed)} m/s`}
              extra={at && at.current_direction_to_deg != null ? `toward ${fmt(at.current_direction_to_deg, 0)}°` : undefined}
              status={curStatus}
              title={environment?.sources?.current?.label ?? undefined}
            />
            <div className="hidden 2xl:block">
              <Reading
                icon={Thermometer}
                label="Sea temp."
                value={sst === null || sst === undefined ? "Not assessed" : `${sst} °C`}
                status={sst === null || sst === undefined ? "NOT_AVAILABLE" : scene.synthetic ? "DEMO_CONSTANT" : "REAL"}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
