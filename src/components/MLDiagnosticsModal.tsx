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
    <div className="fixed inset-0 z-50 bg-ink/30 backdrop-blur-[1px] flex items-center justify-center p-4 select-none">
      <div className="bg-surface border border-line rounded-[6px] max-w-2xl w-full p-6 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto font-mono text-xs">
        <div className="flex items-center justify-between border-b border-line pb-3">
          <div className="flex items-center gap-2"><Cpu className="w-4 h-4 text-navy-600" /><h3 className="font-bold text-ink text-sm">SAR Oil-Spill U-Net — Model Registry</h3></div>
          <button onClick={onClose} className="text-muted hover:text-ink cursor-pointer"><X className="w-4 h-4" /></button>
        </div>
        {err && <div className="text-danger">Could not load ml/model_registry.json: {err}</div>}
        {!m && !err && <div className="text-muted">Loading registry…</div>}
        {m && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <div className="bg-canvas border border-line rounded-[4px] p-2.5"><div className="text-[10px] text-muted">Checkpoint</div><div className="font-bold text-ink mt-0.5">epoch {m.checkpoint.epoch}</div><div className="text-[9px] text-navy-600">{m.version} · {m.role}</div></div>
              <div className="bg-canvas border border-line rounded-[4px] p-2.5"><div className="text-[10px] text-muted">Loss</div><div className="font-bold text-ink mt-0.5">{m.hyperparameters.loss}</div><div className="text-[9px] text-navy-600">lr {m.hyperparameters.learning_rate}, bs {m.hyperparameters.batch_size}</div></div>
              <div className="bg-canvas border border-line rounded-[4px] p-2.5"><div className="text-[10px] text-muted">Validation Dice / IoU</div><div className="font-bold text-ok mt-0.5">{fmt(m.validation_metrics.dice, 3)} / {fmt(m.validation_metrics.iou, 3)}</div><div className="text-[9px] text-muted">P {fmt(m.validation_metrics.precision, 3)} · R {fmt(m.validation_metrics.recall, 3)}</div></div>
              <div className="bg-canvas border border-line rounded-[4px] p-2.5"><div className="text-[10px] text-muted">Test mean Dice / IoU</div><div className="font-bold text-warn mt-0.5">{fmt(m.test_metrics.mean_dice, 3)} / {fmt(m.test_metrics.mean_iou, 3)}</div><div className="text-[9px] text-muted">{m.test_metrics.n_scenes} held-out scenes</div></div>
            </div>
            <div className="space-y-1">
              <h4 className="font-semibold text-ink flex items-center gap-1.5"><Layers className="w-4 h-4 text-navy-600" />Architecture</h4>
              <p className="text-muted text-[11px] font-sans">{m.architecture}</p>
              <p className="text-muted text-[10px] font-sans">Training data: {m.training_data.dataset}. {m.training_data.note}</p>
            </div>
            <div>
              <h4 className="font-semibold text-ink mb-1">Per-scene test metrics ({m.test_metrics.source})</h4>
              <table className="w-full text-[10px]">
                <thead><tr className="text-muted text-left"><th>Scene</th><th>Dice</th><th>IoU</th><th>Precision</th><th>Recall</th></tr></thead>
                <tbody>{per.map(([k, v]) => (
                  <tr key={k} className="border-t border-line"><td className="text-ink">{k}</td>
                    <td style={{ color: v.dice >= 0.7 ? "#16803a" : v.dice >= 0.4 ? "#b7791f" : "#c53030" }}>{fmt(v.dice, 3)}</td>
                    <td>{fmt(v.iou, 3)}</td><td>{fmt(v.precision, 3)}</td><td>{fmt(v.recall, 3)}</td></tr>
                ))}</tbody>
              </table>
              <div className="text-[9px] text-muted mt-1">Calibration, false-positive rate and inference time: not measured.</div>
            </div>
            <div className="bg-canvas border border-warn/40 rounded-[4px] p-3 text-[11px] space-y-1">
              <div className="font-semibold flex items-center gap-1 text-warn"><AlertTriangle className="w-3.5 h-3.5" />Known limitations</div>
              <ul className="list-disc list-inside text-muted font-sans space-y-0.5">{m.known_limitations.map((x: string, i: number) => <li key={i}>{x}</li>)}</ul>
            </div>
            <div className="bg-canvas border border-line rounded-[4px] p-3 text-[11px] space-y-1">
              <div className="font-semibold flex items-center gap-1 text-ink"><Zap className="w-3.5 h-3.5 text-warn" />SAR look-alikes</div>
              <p className="text-muted font-sans">No look-alike classifier is implemented. The investigation flags wind below ~3 m/s at the observation time as look-alike risk (hypothesis H2); this is a warning, not a filter.</p>
            </div>
            <div className="text-[10px] text-muted font-sans">Registry policy: {reg.policy}</div>
          </>
        )}
        <div className="flex justify-end pt-2 border-t border-line">
          <button onClick={onClose} className="px-4 py-1.5 rounded-[4px] bg-canvas hover:bg-subtle text-ink border border-line text-xs cursor-pointer">Close</button>
        </div>
      </div>
    </div>
  );
};
