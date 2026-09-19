import React, { useState, useEffect } from "react";
import { X, Activity, Check } from "lucide-react";
import type { DriftSettings } from "../types";

interface DriftSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  driftParams: DriftSettings;
  onSave: (params: DriftSettings) => void;
  currentAvailable: boolean;
}

export const DriftSettingsModal: React.FC<DriftSettingsModalProps> = ({ isOpen, onClose, driftParams, onSave, currentAvailable }) => {
  const [p, setP] = useState<DriftSettings>(driftParams);
  useEffect(() => { if (isOpen) setP(driftParams); }, [isOpen, driftParams]);
  if (!isOpen) return null;
  const set = (k: keyof DriftSettings, v: number) => setP((prev) => ({ ...prev, [k]: v }));
  const slider = (k: keyof DriftSettings, label: string, shown: string, min: number, max: number, step: number, color: string, help: string) => (
    <div>
      <div className="flex justify-between text-[#C9D1D9] mb-1 text-[11px]"><span>{label}</span><span style={{ color }}>{shown}</span></div>
      <input type="range" min={min} max={max} step={step} value={p[k]} onChange={(e) => set(k, parseFloat(e.target.value))} className="w-full cursor-pointer" style={{ accentColor: color }} />
      <div className="text-[9px] text-[#8B949E] font-sans leading-snug">{help}</div>
    </div>
  );
  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4 select-none">
      <div className="bg-[#161B22] border border-[#30363D] rounded-[6px] max-w-md w-full p-5 shadow-2xl space-y-4 font-mono max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between border-b border-[#30363D] pb-3">
          <div className="flex items-center gap-2"><Activity className="w-4 h-4 text-[#79C0FF]" /><h3 className="font-bold text-[#C9D1D9] text-sm">Lagrangian Drift Physics</h3></div>
          <button onClick={onClose} className="text-[#8B949E] hover:text-[#C9D1D9] cursor-pointer"><X className="w-4 h-4" /></button>
        </div>
        <p className="text-xs text-[#8B949E] leading-relaxed font-sans">
          Surface transport: velocity = current + wind factor × 10 m wind, deflected 5° to the right of the wind in the northern hemisphere (left in the southern), with Gaussian random-walk diffusion √(2·K·dt). RK2 integration. The same parameters drive the backtrack and the T+6/12/24/48 h forecast.
        </p>
        <div className="space-y-3.5 text-xs">
          {slider("driftHours", "Backtrack horizon", `${p.driftHours} h`, 2, 48, 1, "#58A6FF", "Analyst-set window searched for an origin. It is not an estimated release time.")}
          {slider("numParticles", "Ensemble particles", `${p.numParticles}`, 50, 1000, 50, "#79C0FF", "More particles give smoother P50/P90 envelopes and a slower run.")}
          {slider("windFactor", "Wind drift factor", `${(p.windFactor * 100).toFixed(1)} % of 10 m wind`, 0.01, 0.06, 0.005, "#d29922", "Typical oil values are 3–4 %.")}
          {slider("eddyDiffusivity", "Horizontal eddy diffusivity K", `${p.eddyDiffusivity} m²/s`, 0.5, 20, 0.5, "#AFF5B4", "Sub-grid mixing; per-axis spread grows as √(2Kt).")}
          {slider("unknownCurrentSigma", "Unknown-current prior σ", `${p.unknownCurrentSigma.toFixed(2)} m/s`, 0, 0.3, 0.01, "#bc8cff",
            currentAvailable
              ? "A current product is available, so this prior is not applied."
              : "No current product for this scene. Each particle draws a constant zero-mean current from N(0, σ²). This widens the envelopes honestly instead of assuming zero current. Set it to 0 to see the wind-only case.")}
        </div>
        <div className="flex justify-end gap-2 pt-3 border-t border-[#30363D]">
          <button onClick={onClose} className="px-3 py-1.5 rounded-[4px] bg-[#0D1117] hover:bg-[#21262D] text-[#C9D1D9] border border-[#30363D] text-xs cursor-pointer">Cancel</button>
          <button onClick={() => { onSave(p); onClose(); }} className="px-4 py-1.5 rounded-[4px] bg-[#58A6FF] hover:bg-[#79C0FF] text-[#0D1117] text-xs font-bold flex items-center gap-1.5 cursor-pointer border border-[#58A6FF]">
            <Check className="w-3.5 h-3.5" /> Save & re-run
          </button>
        </div>
      </div>
    </div>
  );
};
