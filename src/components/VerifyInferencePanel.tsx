import React, { useEffect, useState } from "react";
import { Cpu, Loader2, CheckCircle2, AlertTriangle } from "lucide-react";
import { Disclose, KV } from "./ui";

/**
 * "Prove the detection is real."
 *
 * The outline shown in the investigation is a PRECOMPUTED MODEL_PREDICTION so the page opens quickly.
 * This control re-runs the SAME frozen checkpoint, live, in this deployment, over the bundled
 * Sentinel-1 raster and prints both pixel counts. Whatever comes back is displayed unchanged —
 * including a mismatch or a runtime that cannot run the model at all.
 */

interface Availability {
  available: boolean;
  raster_present: boolean;
  model_runtime?: { available: boolean; detail: string };
  expected_seconds?: number;
  note?: string;
  stored_prediction?: Record<string, any> | null;
}

export const VerifyInferencePanel: React.FC = () => {
  const [avail, setAvail] = useState<Availability | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [failure, setFailure] = useState<{ reason: string; detail: string } | null>(null);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    fetch("/api/demo/verify-inference")
      .then((r) => r.json())
      .then(setAvail)
      .catch(() => setAvail({ available: false, raster_present: false }));
  }, []);

  useEffect(() => {
    if (!busy) return;
    const t0 = Date.now();
    const id = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 500);
    return () => clearInterval(id);
  }, [busy]);

  const run = async () => {
    setBusy(true);
    setFailure(null);
    setResult(null);
    try {
      const r = await fetch("/api/demo/verify-inference", { method: "POST" });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        setFailure({ reason: d.reason ?? `HTTP ${r.status}`, detail: d.detail ?? "The model could not be run in this deployment." });
      } else {
        setResult(d);
      }
    } catch (e) {
      setFailure({ reason: "REQUEST_FAILED", detail: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  if (avail && !avail.available) {
    return (
      <div className="vn-card p-3.5 space-y-2">
        <h4 className="text-[12px] font-semibold text-ink flex items-center gap-2">
          <Cpu className="w-4 h-4 text-navy-600 shrink-0" aria-hidden="true" />
          Verify detection
        </h4>
        <div className="inline-flex items-center gap-1.5 rounded-full border border-warn/35 bg-warn-50 px-2 py-[2px] text-[10px] font-semibold text-warn">
          <span className="w-1.5 h-1.5 rounded-full bg-warn" aria-hidden="true" />
          PRECOMPUTED DEMO RESULT
        </div>
        <p className="text-[11.5px] text-ink-soft leading-relaxed">
          {avail.note ?? "Live re-inference is not available in this deployment."} The outline shown is the
          stored output of the frozen U-Net, not a live run and not a hand-drawn shape.
        </p>
      </div>
    );
  }

  return (
    <div className="vn-card p-3.5 space-y-2.5">
      <h4 className="text-[12px] font-semibold text-ink flex items-center gap-2">
        <Cpu className="w-4 h-4 text-navy-600 shrink-0" aria-hidden="true" />
        Verify detection
      </h4>

      {!result && (
        <>
          <div className="inline-flex items-center gap-1.5 rounded-full border border-warn/35 bg-warn-50 px-2 py-[2px] text-[10px] font-semibold text-warn">
            <span className="w-1.5 h-1.5 rounded-full bg-warn" aria-hidden="true" />
            PRECOMPUTED DEMO RESULT
          </div>
          <p className="text-[11.5px] text-ink-soft leading-relaxed">
            The outline above was produced offline by the frozen U-Net so this page opens quickly. Run the
            same checkpoint live, here, on the bundled Sentinel-1 raster and compare the two results.
          </p>
          <button
            onClick={run}
            disabled={busy}
            data-testid="verify-inference"
            className="vn-btn vn-btn-primary w-full justify-center"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <Cpu className="w-3.5 h-3.5" aria-hidden="true" />}
            {busy ? `Running U-Net on the SAR scene… ${elapsed}s` : "Run the model live on this scene"}
          </button>
          {busy && (
            <p className="text-[11px] text-muted leading-snug">
              Full-scene inference on CPU typically takes about {avail?.expected_seconds ?? 25}–60 s in a cloud
              container. No progress estimate is shown because the tiling loop does not report one.
            </p>
          )}
        </>
      )}

      {failure && (
        <div className="rounded-[8px] border border-warn/30 bg-warn-50 p-2.5">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-warn shrink-0 mt-[1px]" aria-hidden="true" />
            <div className="min-w-0">
              <div className="text-[11.5px] font-semibold text-warn">{failure.reason}</div>
              <p className="text-[11px] text-ink-soft leading-snug mt-0.5">{failure.detail}</p>
              <p className="text-[11px] text-muted leading-snug mt-1.5">
                The stored MODEL_PREDICTION polygons are unchanged and remain the only detection shown.
              </p>
            </div>
          </div>
        </div>
      )}

      {result && (
        <>
          <div
            className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-[2px] text-[10px] font-semibold ${
              result.comparison?.identical ? "border-ok/35 bg-ok-50 text-ok" : "border-warn/35 bg-warn-50 text-warn"
            }`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${result.comparison?.identical ? "bg-ok" : "bg-warn"}`} aria-hidden="true" />
            LIVE MODEL INFERENCE
          </div>

          <div className="flex items-start gap-2">
            {result.comparison?.identical
              ? <CheckCircle2 className="w-4 h-4 text-ok shrink-0 mt-[1px]" aria-hidden="true" />
              : <AlertTriangle className="w-4 h-4 text-warn shrink-0 mt-[1px]" aria-hidden="true" />}
            <p className="text-[11.5px] text-ink-soft leading-relaxed">{result.comparison?.statement}</p>
          </div>

          <div className="grid grid-cols-2 gap-2 pt-1">
            <div className="rounded-[8px] bg-subtle p-2.5">
              <div className="vn-label">Live run</div>
              <div className="vn-num text-[15px] font-semibold text-ink mt-0.5">
                {Number(result.comparison?.live_positive_pixels ?? 0).toLocaleString()} px
              </div>
              <div className="text-[10.5px] text-muted mt-0.5">this deployment, just now</div>
            </div>
            <div className="rounded-[8px] bg-subtle p-2.5">
              <div className="vn-label">Stored prediction</div>
              <div className="vn-num text-[15px] font-semibold text-ink mt-0.5">
                {Number(result.comparison?.stored_positive_pixels ?? 0).toLocaleString()} px
              </div>
              <div className="text-[10.5px] text-muted mt-0.5">precomputed, bundled</div>
            </div>
          </div>

          <Disclose summary="View live run details">
            <div className="space-y-0">
              <KV k="Checkpoint SHA-256" v={String(result.live?.model?.checkpoint_sha256 ?? "n/a").slice(0, 16) + "…"} />
              <KV k="Checkpoint unchanged" v={result.live?.model?.checkpoint_unchanged ? "yes (verified before and after)" : "NO"} />
              <KV k="Device" v={result.live?.model?.device ?? "n/a"} />
              <KV k="Threshold" v={String(result.live?.model?.threshold ?? "n/a")} />
              <KV k="Normalisation" v={result.live?.model?.normalization ?? "n/a"} />
              <KV k="Tiling" v={result.live?.model?.tiling ?? "n/a"} />
              <KV k="Max probability" v={String(result.live?.prediction?.max_probability ?? "n/a")} />
              <KV k="Connected components" v={String(result.live?.prediction?.connected_components ?? "n/a")} />
              <KV k="Inference time" v={`${result.live?.duration_seconds ?? "?"} s`} />
            </div>
            {Array.isArray(result.live?.notes) && result.live.notes.length > 0 && (
              <ul className="mt-2 space-y-1 list-disc pl-4">
                {result.live.notes.map((n: string, i: number) => (
                  <li key={i} className="text-[11px] text-muted leading-snug">{n}</li>
                ))}
              </ul>
            )}
          </Disclose>

          <p className="text-[11px] text-muted leading-snug">
            The investigation continues to use the stored polygons; this run is a verification and does not
            alter any result shown elsewhere.
          </p>
        </>
      )}
    </div>
  );
};
