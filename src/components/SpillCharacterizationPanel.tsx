import React from "react";
import { Sparkles, Waves, Wind, Radio, AlertTriangle } from "lucide-react";
import type { Scene, SpillDetection, DriftSimulation, EnvironmentState, InvestigationView } from "../types";
import { fmt, fmtLatLon, statusColor, utc } from "../lib/format";

interface Props {
  scene: Scene | null;
  detection: SpillDetection | null;
  drift: DriftSimulation | null;
  environment: EnvironmentState | null;
  investigation: InvestigationView | null;
}

const Label: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="block text-[10px] text-[#8B949E] font-medium tracking-wider uppercase mb-1">{children}</span>
);

export const SpillCharacterizationPanel: React.FC<Props> = ({ scene, detection, drift, environment, investigation }) => {
  const q = detection?.segmentation_quality as any;
  const g = detection?.geometry;
  const at = environment?.at_observation;
  const nWarn = investigation?.state.warnings.length ?? 0;
  return (
    <aside className="w-full h-full bg-[#0D1117] flex flex-col shrink-0 overflow-hidden select-none">
      <div className="p-3.5 border-b border-[#30363D] bg-[#161B22] flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <Sparkles className="w-3.5 h-3.5 text-[#58A6FF]" />
          <h2 className="text-[11px] font-bold text-[#8B949E] uppercase tracking-wider">Spill Characterization</h2>
        </div>
        {detection && (
          <span className="font-mono text-[10px] px-1.5 py-0.5 rounded-[3px] border font-semibold"
            style={{ color: detection.synthetic ? "#bc8cff" : "#FF4444", borderColor: detection.synthetic ? "#bc8cff55" : "#FF444455" }}>
            {detection.synthetic ? "SYNTHETIC" : "ACTIVE"}
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4 text-xs">
        {detection && g ? (
          <>
            <div><Label>Detection ID</Label><span className="font-mono text-[12px] text-[#C9D1D9] font-semibold break-all">S1_{detection.spill_id}</span></div>
            <div><Label>Observation Time (UTC)</Label><span className="font-mono text-[12px] text-[#C9D1D9]">{utc(detection.detection_time)}</span></div>
            <div><Label>Centroid (Lat / Lon)</Label><span className="font-mono text-[12px] text-[#79C0FF] font-semibold">{fmtLatLon(g.centroid)}</span></div>

            <div className="grid grid-cols-2 gap-2 bg-[#161B22] border border-[#30363D] rounded-[4px] p-2.5">
              <div>
                <span className="block text-[9px] text-[#8B949E] uppercase tracking-wider">Area</span>
                <span className="font-mono text-[13px] font-bold text-[#C9D1D9]">{fmt(g.area_km2)} km²</span>
                <span className="block text-[9px] text-[#8B949E] font-mono">{fmt(g.area_hectares, 0)} ha</span>
              </div>
              <div>
                <span className="block text-[9px] text-[#8B949E] uppercase tracking-wider">Perimeter</span>
                <span className="font-mono text-[13px] font-bold text-[#C9D1D9]">{fmt(g.perimeter_km, 1)} km</span>
                <span className="block text-[9px] text-[#8B949E] font-mono">axis {fmt(g.orientation_deg, 1)}° · elong. {fmt(g.elongation ?? null)}</span>
              </div>
            </div>

            <div>
              <Label>Outline provenance</Label>
              <span className="font-mono text-[10px] px-1.5 py-0.5 rounded border" style={{ color: statusColor(detection.geometry_source), borderColor: statusColor(detection.geometry_source) + "66" }}>{detection.geometry_source ?? "UNKNOWN"}</span>
              <p className="text-[10px] text-[#8B949E] mt-1 leading-snug">{detection.geometry_source_detail}</p>
            </div>

            {q && (
              <div>
                <Label>Segmentation quality (frozen U-Net)</Label>
                <div className="bg-[#161B22] border border-[#30363D] rounded-[4px] p-2 space-y-1 font-mono text-[11px]">
                  <div className="text-[9px] text-[#8b9cff] uppercase tracking-wider" title="Computed by ml/inference/run_unet_scene.py and ml/evaluation/run_eval.py in this project">Measured (this run)</div>
                  <div className="flex justify-between"><span className="text-[#8B949E]">This scene, Dice vs label</span><span className="text-[#AFF5B4]">{q.scene_dice_vs_label != null ? fmt(q.scene_dice_vs_label, 3) : "NOT MEASURED"}</span></div>
                  {q.scene_iou_vs_label != null && <div className="flex justify-between"><span className="text-[#8B949E]">IoU / precision / recall</span><span className="text-[#C9D1D9]">{fmt(q.scene_iou_vs_label, 2)} / {fmt(q.scene_precision_vs_label, 2)} / {fmt(q.scene_recall_vs_label, 2)}</span></div>}
                  <div className="flex justify-between"><span className="text-[#8B949E]">Test-set mean Dice (7 scenes)</span><span className="text-[#d29922]">{q.fresh_test_set_mean_dice_scene_overlap_protocol != null ? fmt(q.fresh_test_set_mean_dice_scene_overlap_protocol, 3) : "NOT MEASURED"}</span></div>
                  <div className="text-[9px] text-[#8B949E] pt-1 border-t border-[#30363D] uppercase tracking-wider" title="Recorded in ml/model_registry.json from the original evaluation">Stored historical</div>
                  <div className="flex justify-between"><span className="text-[#8B949E]">This scene / test mean Dice</span><span className="text-[#C9D1D9]">{fmt(q.stored_historical_scene_dice ?? null, 3)} / {fmt(q.fresh_test_set_mean_dice_historic_protocol ?? q.test_set_mean_dice ?? null, 3)}</span></div>
                  <div className="flex justify-between"><span className="text-[#8B949E]">Validation Dice (optimistic)</span><span className="text-[#8B949E]">{fmt(q.validation_dice, 3)}</span></div>
                </div>
                <p className="text-[9px] text-[#8B949E] mt-1 leading-snug">{q.note} Validation is optimistic (train and validation patches share the same source scenes). Probabilities are not calibrated, so no per-pixel confidence is shown.</p>
              </div>
            )}

            {detection.reference_label && (
              <div className="rounded-[4px] border border-[#e3b341]/40 bg-[#e3b341]/5 p-2">
                <Label>Reference label (evaluation only)</Label>
                <div className="font-mono text-[11px] text-[#C9D1D9]">{fmt(detection.reference_label.area_km2)} km² · {detection.reference_label.pixel_count} px</div>
                <p className="text-[9px] text-[#8B949E] mt-1 leading-snug">Labelled mask of the dataset. It is not a model prediction and never feeds the drift, attribution or hypotheses. Toggle it in the map's Layers.</p>
              </div>
            )}

            {drift?.probable_origin && (
              <div className="pt-3 border-t border-[#30363D] space-y-2">
                <Label>Backtrack origin region (P90)</Label>
                <div className="bg-[#161B22] border border-[#30363D] rounded-[4px] p-2 space-y-1 font-mono text-[11px]">
                  <div className="flex justify-between"><span className="text-[#8B949E]">Centroid:</span><span className="text-[#79C0FF]">{fmtLatLon(drift.probable_origin.centroid, 3)}</span></div>
                  <div className="flex justify-between"><span className="text-[#8B949E]">P90 radius:</span><span className="text-[#C9D1D9]">{fmt(drift.probable_origin.uncertainty_radius_km)} km</span></div>
                  <div className="flex justify-between"><span className="text-[#8B949E]">Horizon:</span><span className="text-[#C9D1D9]">T-{fmt(drift.simulation_duration_hours, 0)} h (analyst-set)</span></div>
                </div>
              </div>
            )}

            <div className="pt-3 border-t border-dashed border-[#30363D] space-y-2">
              <Label>Environmental state at T0</Label>
              {at ? (
                <div className="space-y-1.5 text-[11px]">
                  <div className="flex items-center justify-between text-[#C9D1D9]">
                    <span className="text-[#8B949E] flex items-center gap-1"><Wind className="w-3 h-3 text-[#58A6FF]" /> Wind:</span>
                    <span className="font-mono">{fmt(at.wind_speed_knots, 1)} kn from {fmt(at.wind_direction_from_deg, 0)}° <span style={{ color: statusColor(at.wind_status) }}>●</span></span>
                  </div>
                  <div className="flex items-center justify-between text-[#C9D1D9]">
                    <span className="text-[#8B949E] flex items-center gap-1"><Waves className="w-3 h-3 text-[#79C0FF]" /> Current:</span>
                    <span className="font-mono">{at.current_speed_ms === null ? "no product" : `${fmt(at.current_speed_ms)} m/s`} <span style={{ color: statusColor(at.current_status) }}>●</span></span>
                  </div>
                  <div className="flex items-center justify-between text-[#C9D1D9]">
                    <span className="text-[#8B949E]">Wind vs slick axis:</span>
                    <span className="font-mono">{fmt(environment?.wind_slick_axis_difference_deg ?? null, 1)}°</span>
                  </div>
                  <div className="text-[9px] text-[#8B949E] leading-snug border-t border-[#30363D] pt-1.5">
                    <div>Wind source: {environment?.sources?.wind?.label ?? "n/a"} <span style={{ color: statusColor(environment?.sources?.wind?.status) }}>[{environment?.sources?.wind?.status ?? "n/a"}]</span></div>
                    <div>Current source: {environment?.sources?.current?.label ?? "n/a"} <span style={{ color: statusColor(environment?.sources?.current?.status) }}>[{environment?.sources?.current?.status ?? "n/a"}]</span></div>
                    <div>Coverage of drift windows: backtrack {environment?.coverage?.backward_window_fraction != null ? `${Math.round(environment.coverage.backward_window_fraction * 100)} %` : "n/a"} · forecast {environment?.coverage?.forward_window_fraction != null ? `${Math.round(environment.coverage.forward_window_fraction * 100)} %` : "n/a"} (wind product)</div>
                    <div className="text-[#6e7681]">NOT ASSESSED: wave height, SST, coastal exposure</div>
                  </div>
                  {environment?.low_wind_lookalike_risk && (
                    <div className="text-[10px] text-[#d29922] flex gap-1"><AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />Wind below ~3 m/s: look-alike risk. No look-alike classifier is implemented.</div>
                  )}
                </div>
              ) : <div className="text-[10px] text-[#8B949E]">{scene ? "Awaiting environmental analysis." : ""}</div>}
            </div>

            {nWarn > 0 && (
              <div className="pt-3 border-t border-[#30363D]">
                <Label>Investigation warnings ({nWarn})</Label>
                <ul className="space-y-1 text-[10px] text-[#d29922] leading-snug">
                  {investigation!.state.warnings.slice(0, 8).map((w, i) => <li key={i}>• {w}</li>)}
                </ul>
                {nWarn > 8 && <div className="text-[9px] text-[#8B949E] mt-1">+{nWarn - 8} more in the Agents tab</div>}
              </div>
            )}
          </>
        ) : (
          <div className="h-48 flex flex-col items-center justify-center text-center text-[#8B949E] p-4">
            <Radio className="w-8 h-8 text-[#30363D] mb-2 animate-pulse" />
            <span className="text-xs">No active slick selected</span>
            <span className="text-[10px] text-[#484F58] mt-1">Select a scene to view geometry & drift analytics</span>
          </div>
        )}
      </div>
    </aside>
  );
};
