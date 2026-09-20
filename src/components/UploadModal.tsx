import React, { useRef, useState } from "react";
import { Upload, Loader2, AlertTriangle, CheckCircle2, Image as ImageIcon, Layers, Search } from "lucide-react";
import { Modal, KV, Tag, Disclose } from "./ui";
import { fmt } from "../lib/format";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** Start the existing investigation pipeline on the uploaded scene. */
  onInvestigate: (sceneId: string) => void;
  busy?: boolean;
}

type Phase = "idle" | "running" | "done" | "error";

const ACCEPT = ".tif,.tiff,.img,.jp2,.vrt,.dat";

/**
 * Upload a SAR raster and score it with the EXISTING frozen U-Net (server route /api/uploads/sar,
 * which runs ml/inference/predict_upload.py). Everything shown here comes from that response.
 */
export const UploadModal: React.FC<Props> = ({ isOpen, onClose, onInvestigate, busy }) => {
  const [file, setFile] = useState<File | null>(null);
  const [observedAt, setObservedAt] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [resp, setResp] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  const [showOverlay, setShowOverlay] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);

  const reset = () => { setFile(null); setPhase("idle"); setResp(null); setErr(null); setObservedAt(""); };
  const close = () => { reset(); onClose(); };

  const analyse = async () => {
    if (!file) return;
    setPhase("running"); setErr(null); setResp(null);
    try {
      const qs = new URLSearchParams({ filename: file.name });
      if (observedAt) qs.set("observed_at", new Date(observedAt).toISOString());
      const r = await fetch(`/api/uploads/sar?${qs.toString()}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: file,
      });
      const d = await r.json();
      if (!r.ok || !d.ok) { setErr(d); setPhase("error"); return; }
      setResp(d); setPhase("done");
    } catch (e) {
      setErr({ reason: "UPLOAD_FAILED", detail: (e as Error).message });
      setPhase("error");
    }
  };

  const p = resp?.result?.prediction;
  const inp = resp?.result?.input;
  const model = resp?.result?.model;
  const detected = !!p?.detected;

  return (
    <Modal
      isOpen={isOpen}
      onClose={close}
      title="Upload satellite / SAR image"
      icon={Upload}
      subtitle="Scored with the frozen U-Net checkpoint already in this project. Nothing is retrained."
      maxWidth="max-w-3xl"
      footer={
        <>
          <button onClick={close} className="vn-btn">Close</button>
          {phase === "done" && (
            <button
              onClick={() => { const id = resp.scene_id; close(); onInvestigate(id); }}
              disabled={!resp?.result?.investigable || busy}
              className="vn-btn vn-btn-primary"
              title={resp?.result?.investigable ? "Run the full investigation pipeline on this detection" : "Additional investigation data required"}
            >
              <Search className="w-4 h-4" aria-hidden="true" />
              Investigate this spill
            </button>
          )}
          {phase !== "done" && (
            <button onClick={analyse} disabled={!file || phase === "running"} className="vn-btn vn-btn-primary">
              {phase === "running" ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Upload className="w-4 h-4" aria-hidden="true" />}
              {phase === "running" ? "Running the model…" : "Analyse with U-Net"}
            </button>
          )}
        </>
      }
    >
      {/* ---------------- picker */}
      {phase !== "done" && (
        <div className="space-y-4">
          <div
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) { setFile(f); setPhase("idle"); setErr(null); } }}
            className="border-2 border-dashed border-line-strong rounded-[12px] p-6 text-center cursor-pointer hover:border-navy-600/50 hover:bg-subtle/60"
          >
            <ImageIcon className="w-7 h-7 text-line-strong mx-auto mb-2" aria-hidden="true" />
            <p className="text-[13px] font-medium text-ink">{file ? file.name : "Choose a SAR raster or drop it here"}</p>
            <p className="text-[11px] text-muted mt-1">
              {file ? `${(file.size / 1e6).toFixed(1)} MB` : "Single-band Sentinel-1 style GeoTIFF of VV backscatter (.tif, .tiff, .img, .jp2, .vrt)"}
            </p>
            <input ref={inputRef} type="file" accept={ACCEPT} className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) { setFile(f); setPhase("idle"); setErr(null); } }} />
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <label className="text-[12px] text-muted">
              <span className="block vn-label mb-1">Observation time (UTC, optional)</span>
              <input
                type="datetime-local"
                value={observedAt}
                onChange={(e) => setObservedAt(e.target.value)}
                className="border border-line-strong rounded-[8px] px-2.5 py-1.5 text-[12px] text-ink bg-surface"
              />
            </label>
            <p className="text-[11px] text-muted flex-1 min-w-[16rem] leading-snug">
              Used as T0 for drift. If you leave it empty the upload time is used, and the result says so.
            </p>
          </div>

          <div className="rounded-[10px] bg-subtle border border-line p-3 text-[11px] text-muted leading-relaxed">
            <b className="text-ink-soft">What this does:</b> the raster is scored by the frozen U-Net checkpoint
            (whole-scene z-score, 256 px tiles, threshold 0.5). 8-bit photographs, screenshots and RGB quicklooks are
            rejected rather than scored — they are not SAR backscatter. Model probabilities are not calibrated, so no
            confidence value is reported.
          </div>

          {phase === "error" && (
            <div className="rounded-[10px] border border-warn/30 bg-warn-50 p-3">
              <div className="flex items-center gap-2 text-[13px] font-semibold text-warn">
                <AlertTriangle className="w-4 h-4" aria-hidden="true" />
                {err?.reason === "UNSUPPORTED_INPUT"
                  ? "Unsupported image format/input for the current SAR model"
                  : err?.reason === "MODEL_RUNTIME_UNAVAILABLE"
                    ? "Model runtime not available on this server"
                    : err?.reason === "INPUT_TOO_LARGE"
                      ? "File too large"
                      : "The upload could not be analysed"}
              </div>
              <p className="text-[12px] text-ink-soft mt-1.5 leading-relaxed">{err?.detail}</p>
              {err?.input && (
                <p className="text-[11px] text-muted mt-1.5">
                  Detected: {err.input.width}×{err.input.height} px, {err.input.bands} band(s), {err.input.dtype}
                  {err.input.crs ? `, ${err.input.crs}` : ", no CRS"}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* ---------------- result */}
      {phase === "done" && resp && (
        <div className="space-y-4">
          <div className={`rounded-[10px] border p-3 ${detected ? "border-warn/40 bg-warn-50" : "border-ok/30 bg-ok-50"}`}>
            <div className="flex items-center gap-2">
              {detected ? <AlertTriangle className="w-5 h-5 text-warn" aria-hidden="true" /> : <CheckCircle2 className="w-5 h-5 text-ok" aria-hidden="true" />}
              <span className={`text-[15px] font-semibold ${detected ? "text-warn" : "text-ok"}`}>
                {detected ? "Oil spill detected" : "No oil spill detected"}
              </span>
            </div>
            <p className="text-[12px] text-ink-soft mt-1.5 leading-relaxed">
              {detected
                ? `The model predicts ${p.pixels_in_kept_components.toLocaleString()} oil-like pixels${p.area_km2 != null ? ` covering ${fmt(p.area_km2)} km²` : ""} in ${resp.result.geometry?.polygons?.length ?? 0} polygon(s).`
                : `The model predicted no region above the size filter${p.positive_pixels ? ` (${p.positive_pixels} isolated pixels were dropped as specks)` : ""}.`}
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="vn-label">{showOverlay ? "Prediction overlay" : "Uploaded image"}</span>
                <button onClick={() => setShowOverlay((o) => !o)} className="vn-btn !py-1">
                  <Layers className="w-3.5 h-3.5 text-navy-600" aria-hidden="true" />
                  {showOverlay ? "Show original" : "Show overlay"}
                </button>
              </div>
              <img
                src={showOverlay ? resp.overlay_url : resp.preview_url}
                alt={showOverlay ? "Uploaded SAR image with predicted oil pixels in red" : "Uploaded SAR image"}
                className="w-full rounded-[10px] border border-line bg-subtle"
              />
              <p className="text-[10.5px] text-muted mt-1">
                Grayscale display stretch of the uploaded band{showOverlay ? "; red = predicted oil pixels" : ""}. Display only — never used for inference.
              </p>
            </div>

            <div className="space-y-0">
              <KV k="File" v={resp.filename} mono={false} />
              <KV k="Raster" v={`${inp.width}×${inp.height} px, ${inp.bands} band, ${inp.dtype}`} />
              <KV k="CRS" v={inp.crs ?? "none (not georeferenced)"} />
              <KV k="Value range" v={`${fmt(inp.value_stats.min, 1)} … ${fmt(inp.value_stats.max, 1)}`} />
              <KV k="In training value range" v={inp.in_training_value_range ? "yes" : "NO — out of distribution"} />
              <KV k="Predicted pixels" v={`${p.positive_pixels.toLocaleString()} (${p.pixels_in_kept_components.toLocaleString()} kept)`} />
              <KV k="Detected area" v={p.area_km2 != null ? `${fmt(p.area_km2)} km²` : "not georeferenced"} />
              <KV k="Max model probability" v={`${fmt(p.max_probability, 3)} (uncalibrated)`} />
              <KV k="Checkpoint" v={`${String(model.checkpoint_sha256).slice(0, 12)}… epoch ${model.epoch}`} />
              <KV k="Threshold / device" v={`${model.threshold} / ${model.device}`} />

              {!resp.result.investigable && (
                <div className="mt-3 rounded-[8px] border border-line bg-subtle p-2.5 text-[11.5px] text-muted leading-relaxed">
                  <b className="text-ink-soft">Additional investigation data required.</b>{" "}
                  {inp.crs ? "No mappable slick polygons were produced, so drift and attribution cannot run." : "The raster has no CRS, so the detection has no location and cannot be drifted or matched to AIS."}
                </div>
              )}
              {resp.result.investigable && (
                <div className="mt-3 rounded-[8px] border border-navy-600/20 bg-navy-50 p-2.5 text-[11.5px] text-ink-soft leading-relaxed">
                  This detection can be investigated. Wind, current and AIS products do not exist for an arbitrary
                  uploaded scene, so drift runs on its uncertainty prior and vessel attribution will report that
                  additional data is required.
                </div>
              )}
            </div>
          </div>

          <Disclose summary="Model notes and limitations">
            <ul className="space-y-1 text-[11.5px] text-muted leading-snug">
              {(resp.result.notes ?? []).map((nt: string, i: number) => (
                <li key={i} className="flex gap-1.5">
                  <span aria-hidden="true">•</span>
                  {nt}
                </li>
              ))}
            </ul>
          </Disclose>

          <div className="flex items-center gap-2 flex-wrap">
            <Tag tone="info">Frozen checkpoint, read-only</Tag>
            <Tag tone={model.checkpoint_unchanged ? "ok" : "danger"}>
              {model.checkpoint_unchanged ? "Checkpoint unchanged" : "Checkpoint CHANGED"}
            </Tag>
            <Tag tone="neutral">{resp.result.duration_seconds}s</Tag>
            <button onClick={reset} className="vn-btn ml-auto">Analyse another image</button>
          </div>
        </div>
      )}
    </Modal>
  );
};
