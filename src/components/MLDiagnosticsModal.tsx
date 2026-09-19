import React, { useEffect, useState } from "react";
import { X, Cpu, Layers, Zap, AlertTriangle } from "lucide-react";
import { fmt } from "../lib/format";

interface MLDiagnosticsModalProps { isOpen: boolean; onClose: () => void; }

export const MLDiagnosticsModal: React.FC<MLDiagnosticsModalProps> = ({ isOpen, onClose }) => {
  const [reg, setReg] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!isOpen || reg) return;
    fetch("/api/model/registry").then(async (r) => {
      if (!r.ok) throw new Error((await r.json()).error ?? r.statusText);
      return r.json();
    }).then(setReg).catch((e) => setErr(e.message));
  }, [isOpen, reg]);
  if (!isOpen) return null;
  const m = reg?.models?.find((x: any) => x.role === "production-baseline");
  const per = m ? Object.entries(m.test_metrics.per_scene as Record<string, any>) : [];
  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4 select-none">
      <div className="bg-[#161B22] border border-[#30363D] rounded-[6px] max-w-2xl w-full p-6 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto font-mono text-xs">
        <div className="flex items-center justify-between border-b border-[#30363D] pb-3">
          <div className="flex items-center gap-2"><Cpu className="w-4 h-4 text-[#58A6FF]" /><h3 className="font-bold text-[#C9D1D9] text-sm">SAR Oil-Spill U-Net — Model Registry</h3></div>
          <button onClick={onClose} className="text-[#8B949E] hover:text-[#C9D1D9] cursor-pointer"><X className="w-4 h-4" /></button>
        </div>
        {err && <div className="text-[#f85149]">Could not load ml/model_registry.json: {err}</div>}
        {!m && !err && <div className="text-[#8B949E]">Loading registry…</div>}
        {m && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <div className="bg-[#0D1117] border border-[#30363D] rounded-[4px] p-2.5"><div className="text-[10px] text-[#8B949E]">Checkpoint</div><div className="font-bold text-[#C9D1D9] mt-0.5">epoch {m.checkpoint.epoch}</div><div className="text-[9px] text-[#58A6FF]">{m.version} · {m.role}</div></div>
              <div className="bg-[#0D1117] border border-[#30363D] rounded-[4px] p-2.5"><div className="text-[10px] text-[#8B949E]">Loss</div><div className="font-bold text-[#C9D1D9] mt-0.5">{m.hyperparameters.loss}</div><div className="text-[9px] text-[#79C0FF]">lr {m.hyperparameters.learning_rate}, bs {m.hyperparameters.batch_size}</div></div>
              <div className="bg-[#0D1117] border border-[#30363D] rounded-[4px] p-2.5"><div className="text-[10px] text-[#8B949E]">Validation Dice / IoU</div><div className="font-bold text-[#AFF5B4] mt-0.5">{fmt(m.validation_metrics.dice, 3)} / {fmt(m.validation_metrics.iou, 3)}</div><div className="text-[9px] text-[#8B949E]">P {fmt(m.validation_metrics.precision, 3)} · R {fmt(m.validation_metrics.recall, 3)}</div></div>
              <div className="bg-[#0D1117] border border-[#30363D] rounded-[4px] p-2.5"><div className="text-[10px] text-[#8B949E]">Test mean Dice / IoU</div><div className="font-bold text-[#d29922] mt-0.5">{fmt(m.test_metrics.mean_dice, 3)} / {fmt(m.test_metrics.mean_iou, 3)}</div><div className="text-[9px] text-[#8B949E]">{m.test_metrics.n_scenes} held-out scenes</div></div>
            </div>
            <div className="space-y-1">
              <h4 className="font-semibold text-[#C9D1D9] flex items-center gap-1.5"><Layers className="w-4 h-4 text-[#58A6FF]" />Architecture</h4>
              <p className="text-[#8B949E] text-[11px] font-sans">{m.architecture}</p>
              <p className="text-[#8B949E] text-[10px] font-sans">Training data: {m.training_data.dataset}. {m.training_data.note}</p>
            </div>
            <div>
              <h4 className="font-semibold text-[#C9D1D9] mb-1">Per-scene test metrics ({m.test_metrics.source})</h4>
              <table className="w-full text-[10px]">
                <thead><tr className="text-[#8B949E] text-left"><th>Scene</th><th>Dice</th><th>IoU</th><th>Precision</th><th>Recall</th></tr></thead>
                <tbody>{per.map(([k, v]) => (
                  <tr key={k} className="border-t border-[#21262D]"><td className="text-[#C9D1D9]">{k}</td>
                    <td style={{ color: v.dice >= 0.7 ? "#3fb950" : v.dice >= 0.4 ? "#d29922" : "#f85149" }}>{fmt(v.dice, 3)}</td>
                    <td>{fmt(v.iou, 3)}</td><td>{fmt(v.precision, 3)}</td><td>{fmt(v.recall, 3)}</td></tr>
                ))}</tbody>
              </table>
              <div className="text-[9px] text-[#8B949E] mt-1">Calibration, false-positive rate and inference time: not measured.</div>
            </div>
            <div className="bg-[#0D1117] border border-[#d29922]/40 rounded-[4px] p-3 text-[11px] space-y-1">
              <div className="font-semibold flex items-center gap-1 text-[#d29922]"><AlertTriangle className="w-3.5 h-3.5" />Known limitations</div>
              <ul className="list-disc list-inside text-[#8B949E] font-sans space-y-0.5">{m.known_limitations.map((x: string, i: number) => <li key={i}>{x}</li>)}</ul>
            </div>
            <div className="bg-[#0D1117] border border-[#30363D] rounded-[4px] p-3 text-[11px] space-y-1">
              <div className="font-semibold flex items-center gap-1 text-[#C9D1D9]"><Zap className="w-3.5 h-3.5 text-[#d29922]" />SAR look-alikes</div>
              <p className="text-[#8B949E] font-sans">No look-alike classifier is implemented. The investigation flags wind below ~3 m/s at the observation time as look-alike risk (hypothesis H2); this is a warning, not a filter.</p>
            </div>
            <div className="text-[10px] text-[#8B949E] font-sans">Registry policy: {reg.policy}</div>
          </>
        )}
        <div className="flex justify-end pt-2 border-t border-[#30363D]">
          <button onClick={onClose} className="px-4 py-1.5 rounded-[4px] bg-[#0D1117] hover:bg-[#21262D] text-[#C9D1D9] border border-[#30363D] text-xs cursor-pointer">Close</button>
        </div>
      </div>
    </div>
  );
};
