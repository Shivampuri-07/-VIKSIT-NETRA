import React, { useEffect, useState } from "react";
import { Waves, Satellite, Ship, Wind, Activity, FileText, ArrowRight, ShieldCheck, Loader2 } from "lucide-react";

/**
 * Public landing page for the deployed demonstration.
 *
 * Everything quoted here is read from the running deployment (/api/health, /api/demo/verify-inference)
 * or is a figure recorded in the project's own data files. Nothing on this screen is a marketing number:
 * the model metrics shown are the measured ones, including the weak scenes.
 */

interface Props {
  onLaunch: () => void;
  version?: string | null;
}

interface Readiness {
  status?: string;
  model?: string | null;
  available_scenes?: number;
  model_runtime?: { available: boolean; detail: string };
}

const STEPS: { icon: React.ElementType; label: string; detail: string }[] = [
  { icon: Satellite, label: "SAR detection", detail: "U-Net segmentation of the Sentinel-1 VV scene" },
  { icon: Waves, label: "Spill geometry", detail: "Area, perimeter, principal axis from the predicted mask" },
  { icon: Wind, label: "Drift & backtracking", detail: "Lagrangian particles forced by ERA5 wind and ocean current" },
  { icon: Ship, label: "AIS correlation", detail: "Real 2018 MarineCadastre tracks intersected with the origin envelope" },
  { icon: Activity, label: "Evidence & analytics", detail: "Four weighted factors, counterfactuals, competing hypotheses" },
  { icon: FileText, label: "Investigation report", detail: "Exportable PDF with full provenance" },
];

export const DemoLanding: React.FC<Props> = ({ onLaunch, version }) => {
  const [ready, setReady] = useState<Readiness | null>(null);
  const [launching, setLaunching] = useState(false);

  useEffect(() => {
    let alive = true;
    // Cold start: the first request may take a few seconds while the server warms up. Retry quietly.
    const poll = (attempt: number) => {
      fetch("/api/health")
        .then((r) => r.json())
        .then((d) => { if (alive) setReady(d); })
        .catch(() => { if (alive && attempt < 20) setTimeout(() => poll(attempt + 1), 1500); });
    };
    poll(0);
    return () => { alive = false; };
  }, []);

  const handleLaunch = () => {
    setLaunching(true);
    onLaunch();
  };

  return (
    <div className="min-h-full w-full overflow-y-auto bg-canvas">
      <div className="mx-auto max-w-5xl px-5 py-10 sm:py-14">
        {/* Brand */}
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-[10px] bg-navy flex items-center justify-center text-white shrink-0" aria-hidden="true">
            <Waves className="w-6 h-6" />
          </div>
          <div className="min-w-0">
            <h1 className="text-[22px] sm:text-[26px] font-semibold text-ink leading-tight tracking-tight">VIKSIT-NETRA</h1>
            <p className="text-[12px] text-muted leading-snug">Viksit Tech · Smart India Hackathon</p>
          </div>
        </div>

        <p className="mt-6 text-[17px] sm:text-[19px] text-ink-soft leading-snug max-w-2xl">
          AI-powered maritime environmental intelligence and oil-spill attribution.
        </p>
        <p className="mt-2 text-[14px] text-navy-600 font-medium">
          See the Spill. Trace the Source. Predict the Drift.
        </p>

        {/* Primary action */}
        <div className="mt-8 flex flex-col sm:flex-row sm:items-center gap-3">
          <button
            onClick={handleLaunch}
            disabled={launching}
            className="inline-flex items-center justify-center gap-2 rounded-[10px] bg-navy px-6 py-3.5 text-white text-[15px] font-semibold shadow-sm hover:bg-navy-600 disabled:opacity-70 transition-colors"
          >
            {launching ? <Loader2 className="w-[18px] h-[18px] animate-spin" /> : <ArrowRight className="w-[18px] h-[18px]" />}
            {launching ? "Opening investigation…" : "Launch Demo Investigation"}
          </button>
          <span className="text-[12px] text-muted">
            One click. No upload, no keys, no configuration.
          </span>
        </div>

        {/* Readiness — honest about what this deployment can do */}
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px]">
          {ready ? (
            <>
              <span className="inline-flex items-center gap-1.5 text-ok">
                <span className="w-1.5 h-1.5 rounded-full bg-ok" aria-hidden="true" />
                Service ready
              </span>
              <span className="text-muted">Model: {ready.model ?? "unavailable"}</span>
              <span className="text-muted">Scenes: {ready.available_scenes ?? "—"}</span>
              <span className={ready.model_runtime?.available ? "text-muted" : "text-warn"}>
                Live re-inference: {ready.model_runtime?.available ? "available" : "not available in this deployment"}
              </span>
            </>
          ) : (
            <span className="inline-flex items-center gap-2 text-muted">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Initializing investigation engine…
            </span>
          )}
        </div>

        {/* What the judge will see */}
        <h2 className="mt-12 text-[13px] font-semibold text-ink uppercase tracking-wide">The investigation runs these stages</h2>
        <ol className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {STEPS.map((s, i) => (
            <li key={s.label} className="vn-card p-4">
              <div className="flex items-start gap-2.5">
                <s.icon className="w-[18px] h-[18px] text-navy-600 shrink-0 mt-0.5" aria-hidden="true" />
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold text-ink leading-tight">
                    <span className="text-faint tabular-nums mr-1.5">{String(i + 1).padStart(2, "0")}</span>
                    {s.label}
                  </div>
                  <p className="text-[11.5px] text-muted leading-snug mt-1">{s.detail}</p>
                </div>
              </div>
            </li>
          ))}
        </ol>

        {/* The scenario — real data, named sources */}
        <h2 className="mt-12 text-[13px] font-semibold text-ink uppercase tracking-wide">The demonstration scenario</h2>
        <div className="mt-4 vn-card p-5">
          <div className="text-[15px] font-semibold text-ink">
            Sentinel-1A oil-spill benchmark — 26 September 2018, Northern Gulf of Mexico
          </div>
          <dl className="mt-4 grid gap-x-6 gap-y-3 sm:grid-cols-2 text-[12px]">
            <div>
              <dt className="vn-label">Satellite imagery</dt>
              <dd className="text-ink-soft mt-0.5">
                Sentinel-1A VV backscatter, 10 m, EPSG:32616 — the held-out test scene of the Zenodo 4672426
                oil-spill dataset. Bundled with this deployment as the original float32 raster.
              </dd>
            </div>
            <div>
              <dt className="vn-label">Vessel traffic</dt>
              <dd className="text-ink-soft mt-0.5">
                13,104 real AIS position reports (NOAA/USCG Nationwide AIS via MarineCadastre, 2018),
                56 vessels active in the scene window.
              </dd>
            </div>
            <div>
              <dt className="vn-label">Environmental forcing</dt>
              <dd className="text-ink-soft mt-0.5">
                ECMWF ERA5 10 m wind and a gridded ocean-current field, both for the acquisition date.
              </dd>
            </div>
            <div>
              <dt className="vn-label">Detection</dt>
              <dd className="text-ink-soft mt-0.5">
                53.45 km² across 9 retained polygons, produced by the frozen U-Net checkpoint
                (SHA-256 33688d9b…, epoch 3) at threshold 0.5.
              </dd>
            </div>
          </dl>
        </div>

        {/* Honesty block — live vs precomputed, and the real metrics */}
        <h2 className="mt-12 text-[13px] font-semibold text-ink uppercase tracking-wide">What is live and what is precomputed</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="vn-card p-4">
            <div className="inline-flex items-center gap-1.5 rounded-full border border-ok/35 bg-ok-50 px-2 py-[2px] text-[10px] font-semibold text-ok">
              <span className="w-1.5 h-1.5 rounded-full bg-ok" aria-hidden="true" />
              COMPUTED LIVE
            </div>
            <ul className="mt-2.5 text-[11.5px] text-ink-soft space-y-1 list-disc pl-4 leading-snug">
              <li>Lagrangian drift and backtracking (particle ensemble)</li>
              <li>AIS track reconstruction and spatio-temporal correlation</li>
              <li>Candidate scoring, evidence fusion, counterfactuals</li>
              <li>Hypotheses, uncertainty, risk, recommendations</li>
              <li>Report generation</li>
            </ul>
          </div>
          <div className="vn-card p-4">
            <div className="inline-flex items-center gap-1.5 rounded-full border border-warn/35 bg-warn-50 px-2 py-[2px] text-[10px] font-semibold text-warn">
              <span className="w-1.5 h-1.5 rounded-full bg-warn" aria-hidden="true" />
              PRECOMPUTED DEMO RESULT
            </div>
            <ul className="mt-2.5 text-[11.5px] text-ink-soft space-y-1 list-disc pl-4 leading-snug">
              <li>The U-Net segmentation mask of the demo scene, so the page opens in seconds</li>
            </ul>
            <p className="mt-2.5 text-[11.5px] text-ink-soft leading-snug">
              You can re-run the model yourself inside the investigation
              (<span className="font-medium">Verify detection</span>): the same frozen checkpoint is executed
              live on the bundled raster and the two pixel counts are shown side by side.
            </p>
          </div>
        </div>

        {/* Measured performance, weaknesses included */}
        <h2 className="mt-12 text-[13px] font-semibold text-ink uppercase tracking-wide">Measured model performance</h2>
        <div className="mt-4 vn-card p-5">
          <div className="grid gap-5 sm:grid-cols-3 text-[12px]">
            <div>
              <div className="vn-label">This demo scene</div>
              <div className="vn-num text-[20px] font-semibold text-ink mt-0.5">Dice 0.843</div>
              <p className="text-[11px] text-muted leading-snug mt-1">
                vs the labelled reference mask; IoU 0.729, precision 0.757, recall 0.952.
              </p>
            </div>
            <div>
              <div className="vn-label">7 held-out scenes (macro)</div>
              <div className="vn-num text-[20px] font-semibold text-ink mt-0.5">Dice 0.465</div>
              <p className="text-[11px] text-muted leading-snug mt-1">
                Per-scene range 0.015 to 0.848. Between-scene variance is large.
              </p>
            </div>
            <div>
              <div className="vn-label">Calibration</div>
              <div className="vn-num text-[20px] font-semibold text-ink mt-0.5">ECE 0.039</div>
              <p className="text-[11px] text-muted leading-snug mt-1">
                Probabilities are reported as raw model output, never as a confidence.
              </p>
            </div>
          </div>
          <p className="mt-4 pt-4 border-t border-line text-[11.5px] text-muted leading-snug">
            <span className="font-medium text-ink-soft">Known limitations.</span> The demo scene is one of the
            model's strongest; the macro figure above is the honest headline. Look-alikes (low wind, biogenic
            films, rain cells) are not modelled, so a dark SAR feature is not proof of petroleum. Validation
            patches share source scenes with training, so the validation split is leaky. Training used per-patch
            normalisation while inference uses whole-scene normalisation.
          </p>
        </div>

        {/* Scope */}
        <div className="mt-8 vn-card p-4 border-l-[3px] border-l-navy">
          <div className="flex items-start gap-2.5">
            <ShieldCheck className="w-[18px] h-[18px] text-navy-600 shrink-0 mt-0.5" aria-hidden="true" />
            <p className="text-[12px] text-ink-soft leading-snug">
              VIKSIT-NETRA ranks <span className="font-medium">candidate vessels</span> by evidence compatibility
              to prioritise investigation. It does not establish causation or legal responsibility, and its output
              is decision support for a human investigator.
            </p>
          </div>
        </div>

        <footer className="mt-10 pb-4 text-[11px] text-faint">
          VIKSIT-NETRA {version ? `v${version}` : ""} · Viksit Tech · Data: Copernicus Sentinel-1, ECMWF ERA5,
          NOAA/USCG MarineCadastre AIS
        </footer>
      </div>
    </div>
  );
};
