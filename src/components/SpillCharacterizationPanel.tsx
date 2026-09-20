import React from "react";
import { Radio, Wind, Waves, AlertTriangle, Crosshair, Target, FileWarning } from "lucide-react";
import type { Scene, SpillDetection, DriftSimulation, EnvironmentState, InvestigationView } from "../types";
import { fmt, fmtLatLon, statusColor, statusLabel, utc } from "../lib/format";
import { StatusChip, Disclose, KV, EmptyState } from "./ui";
import { VerifyInferencePanel } from "./VerifyInferencePanel";

interface Props {
  scene: Scene | null;
  detection: SpillDetection | null;
  drift: DriftSimulation | null;
  environment: EnvironmentState | null;
  investigation: InvestigationView | null;
}

const SectionTitle: React.FC<{ children: React.ReactNode; icon?: React.ElementType }> = ({ children, icon: Icon }) => (
  <h4 className="text-[12px] font-semibold text-ink flex items-center gap-1.5 mb-2">
    {Icon && <Icon className="w-3.5 h-3.5 text-navy-600" aria-hidden="true" />}
    {children}
  </h4>
);

/**
 * Incident overview: what was detected, how good the detection is, where the oil probably came
 * from and what the environment was. Long technical strings are behind "View technical details";
 * nothing is hidden, only deferred.
 */
export const SpillCharacterizationPanel: React.FC<Props> = ({ scene, detection, drift, environment, investigation }) => {
  const q = detection?.segmentation_quality as any;
  const g = detection?.geometry;
  const at = environment?.at_observation;
  const warnings = investigation?.state.warnings ?? [];

  if (!detection || !g) {
    return (
      <aside className="w-full h-full bg-canvas flex flex-col overflow-hidden">
        <EmptyState
          icon={Radio}
          title="No incident loaded"
          hint={scene ? "Run the investigation to characterise the slick for this scene." : "Select a scene to begin."}
        />
      </aside>
    );
  }

  const hasDetection = g.has_detection;
  const provenance = detection.geometry_source ?? "UNKNOWN";

  return (
    <aside className="w-full h-full bg-canvas flex flex-col overflow-hidden select-none">
      <div className="px-4 py-3 border-b border-line bg-surface shrink-0">
        <h2 className="text-[13px] font-semibold text-ink">Incident overview</h2>
        <p className="text-[11px] text-muted mt-0.5">Observed slick, detection quality and probable origin.</p>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {/* Key facts */}
        <div className="vn-card p-3.5 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="vn-label">Detection ID</div>
              <div className="text-[14px] font-semibold text-ink vn-num">S1_{detection.spill_id}</div>
            </div>
            <div>
              <div className="vn-label">Observation (UTC)</div>
              <div className="text-[12px] text-ink vn-num leading-tight">{utc(detection.detection_time)}</div>
            </div>
          </div>

          <div>
            <div className="vn-label">Slick centroid</div>
            <div className="text-[13px] text-navy font-medium vn-num">{fmtLatLon(g.centroid)}</div>
          </div>

          {hasDetection ? (
            <div className="grid grid-cols-2 gap-3 pt-3 border-t border-line">
              <div>
                <div className="vn-label">Observed area</div>
                <div className="text-[18px] font-semibold text-ink vn-num leading-tight">{fmt(g.area_km2)} km²</div>
                <div className="text-[11px] text-muted">{fmt(g.area_hectares, 0)} ha</div>
              </div>
              <div>
                <div className="vn-label">Perimeter</div>
                <div className="text-[18px] font-semibold text-ink vn-num leading-tight">{fmt(g.perimeter_km, 1)} km</div>
                <div className="text-[11px] text-muted">
                  axis {fmt(g.orientation_deg, 0)}° · elong. {fmt(g.elongation ?? null)}
                </div>
              </div>
            </div>
          ) : (
            <div className="pt-3 border-t border-line text-[12px] text-muted">No slick geometry was produced for this scene.</div>
          )}

          {(g.n_components ?? 0) > 1 && (
            <div className="text-[11px] text-muted">
              {g.parts?.length ?? 1} polygon{(g.parts?.length ?? 1) === 1 ? "" : "s"} retained of {g.n_components} connected components.
            </div>
          )}
        </div>

        {/* Provenance */}
        <div className="vn-card p-3.5 space-y-2">
          <SectionTitle icon={Target}>Outline provenance</SectionTitle>
          <StatusChip status={provenance} />
          <p className="text-[11.5px] text-ink-soft leading-relaxed">
            {provenance === "MODEL_PREDICTION"
              ? "Polygons produced by the frozen U-Net segmentation model running on the real SAR scene. A model prediction, not a confirmed oil footprint."
              : provenance === "SYNTHETIC_DEMO"
                ? "Synthetic shape generated for interface demonstration. No SAR image or model inference is involved."
                : statusLabel(provenance)}
          </p>
          <Disclose summary="View technical details">
            <p className="text-[11px] text-muted leading-relaxed">{detection.geometry_source_detail}</p>
            {detection.prediction_provenance && (
              <div className="mt-2 space-y-0">
                <KV k="Checkpoint" v={String((detection.prediction_provenance as any).model?.checkpoint_sha256 ?? "n/a").slice(0, 12) + "…"} />
                <KV k="Normalisation" v={(detection.prediction_provenance as any).inference?.normalization ?? "n/a"} />
                <KV k="Threshold" v={String((detection.prediction_provenance as any).inference?.threshold ?? "n/a")} />
                <KV k="Source raster" v={(detection.prediction_provenance as any).source_raster?.file ?? "n/a"} />
                <KV k="Raster CRS" v={(detection.prediction_provenance as any).source_raster?.crs ?? "n/a"} />
              </div>
            )}
          </Disclose>
        </div>

        {/* Live re-inference of this scene (verification only; never replaces the stored prediction) */}
        {provenance === "MODEL_PREDICTION" && <VerifyInferencePanel />}

        {/* Detection quality */}
        {q && (
          <div className="vn-card p-3.5 space-y-2">
            <SectionTitle>Detection quality</SectionTitle>
            {q.scene_dice_vs_label != null ? (
              <>
                <div className="flex items-baseline gap-2">
                  <span className="text-[22px] font-semibold text-ink vn-num leading-none">{fmt(q.scene_dice_vs_label, 3)}</span>
                  <span className="text-[11px] text-muted">Dice vs reference label, this scene</span>
                </div>
                <div className="text-[11px] text-muted">
                  Held-out test-set mean Dice{" "}
                  <span className="vn-num text-ink-soft">{fmt(q.fresh_test_set_mean_dice_scene_overlap_protocol ?? q.test_set_mean_dice ?? null, 3)}</span> across 7 scenes.
                </div>
              </>
            ) : (
              <div className="text-[12px] text-muted">Not measured for this scene.</div>
            )}
            <Disclose summary="View all measured metrics">
              <div className="space-y-0">
                <div className="vn-label mt-1">Measured this run</div>
                <KV k="IoU" v={fmt(q.scene_iou_vs_label ?? null, 3)} />
                <KV k="Precision" v={fmt(q.scene_precision_vs_label ?? null, 3)} />
                <KV k="Recall" v={fmt(q.scene_recall_vs_label ?? null, 3)} />
                <div className="vn-label mt-2">Stored historical</div>
                <KV k="This scene Dice" v={fmt(q.stored_historical_scene_dice ?? null, 3)} />
                <KV k="Test-set mean Dice" v={fmt(q.fresh_test_set_mean_dice_historic_protocol ?? q.test_set_mean_dice ?? null, 3)} />
                <KV k="Validation Dice" v={`${fmt(q.validation_dice, 3)} (optimistic)`} />
              </div>
              <p className="text-[10.5px] text-muted leading-relaxed mt-2">
                {q.note} Validation is optimistic because training and validation patches share the same source scenes. Probabilities are not
                calibrated, so no per-pixel confidence is shown.
              </p>
            </Disclose>
          </div>
        )}

        {/* Reference label */}
        {detection.reference_label && (
          <div className="vn-card p-3.5 space-y-1.5 border-l-[3px] border-l-warn">
            <SectionTitle icon={FileWarning}>Reference label — evaluation only</SectionTitle>
            <div className="text-[12px] text-ink vn-num">
              {fmt(detection.reference_label.area_km2)} km² · {detection.reference_label.pixel_count.toLocaleString()} px
            </div>
            <p className="text-[11px] text-muted leading-relaxed">
              Labelled mask from the dataset. It is not a model prediction and never feeds drift, attribution or hypotheses. Enable it under
              map layers to compare visually.
            </p>
          </div>
        )}

        {/* Origin */}
        {drift?.probable_origin && (
          <div className="vn-card p-3.5 space-y-2">
            <SectionTitle icon={Crosshair}>Probable origin zone</SectionTitle>
            <div className="text-[13px] text-navy font-medium vn-num">{fmtLatLon(drift.probable_origin.centroid, 3)}</div>
            <div className="grid grid-cols-2 gap-3 pt-1">
              <div>
                <div className="vn-label">P90 radius</div>
                <div className="text-[14px] font-semibold text-ink vn-num">{fmt(drift.probable_origin.uncertainty_radius_km)} km</div>
              </div>
              <div>
                <div className="vn-label">Backtrack horizon</div>
                <div className="text-[14px] font-semibold text-ink vn-num">T−{fmt(drift.simulation_duration_hours, 0)} h</div>
              </div>
            </div>
            <p className="text-[11px] text-muted leading-relaxed">
              A region compatible with the modelled transport, not a point of release. The horizon is analyst-set; no release time is estimated.
            </p>
          </div>
        )}

        {/* Environment */}
        <div className="vn-card p-3.5 space-y-2.5">
          <SectionTitle>Environment at observation</SectionTitle>
          {at ? (
            <>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] text-muted flex items-center gap-1.5">
                  <Wind className="w-3.5 h-3.5" aria-hidden="true" /> Wind 10 m
                </span>
                <span className="text-[12px] text-ink vn-num">
                  {fmt(at.wind_speed_ms, 1)} m/s from {fmt(at.wind_direction_from_deg, 0)}°
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] text-muted flex items-center gap-1.5">
                  <Waves className="w-3.5 h-3.5" aria-hidden="true" /> Surface current
                </span>
                <span className="text-[12px] text-ink vn-num">
                  {at.current_speed_ms === null ? "Not assessed" : `${fmt(at.current_speed_ms)} m/s`}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] text-muted">Wind vs slick axis</span>
                <span className="text-[12px] text-ink vn-num">{fmt(environment?.wind_slick_axis_difference_deg ?? null, 0)}°</span>
              </div>

              {environment?.low_wind_lookalike_risk && (
                <div className="flex gap-2 rounded-[8px] bg-warn-50 border border-warn/25 p-2 text-[11px] text-warn leading-snug">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden="true" />
                  <span>
                    Wind is below ~3 m/s, where SAR dark areas are frequently look-alikes. No look-alike classifier is implemented — this is a
                    flag, not a filter.
                  </span>
                </div>
              )}

              <Disclose summary="View sources and coverage">
                <div className="space-y-2 text-[11px]">
                  <div>
                    <div className="vn-label">Wind product</div>
                    <div className="text-ink-soft leading-snug">{environment?.sources?.wind?.label ?? "n/a"}</div>
                    <StatusChip status={environment?.sources?.wind?.status} className="mt-1" />
                  </div>
                  <div>
                    <div className="vn-label">Current product</div>
                    <div className="text-ink-soft leading-snug">{environment?.sources?.current?.label ?? "n/a"}</div>
                    <StatusChip status={environment?.sources?.current?.status} className="mt-1" />
                  </div>
                  <div className="space-y-0 pt-1">
                    <KV
                      k="Wind coverage, backtrack window"
                      v={
                        environment?.coverage?.backward_window_fraction != null
                          ? `${Math.round(environment.coverage.backward_window_fraction * 100)} %`
                          : "n/a"
                      }
                    />
                    <KV
                      k="Wind coverage, forecast window"
                      v={
                        environment?.coverage?.forward_window_fraction != null
                          ? `${Math.round(environment.coverage.forward_window_fraction * 100)} %`
                          : "n/a"
                      }
                    />
                  </div>
                  <p className="text-muted leading-relaxed">Not assessed: wave height, sea-surface temperature, coastal exposure.</p>
                </div>
              </Disclose>
            </>
          ) : (
            <div className="text-[12px] text-muted">Awaiting environmental analysis.</div>
          )}
        </div>

        {/* Warnings */}
        {warnings.length > 0 && (
          <div className="vn-card p-3.5">
            <SectionTitle icon={AlertTriangle}>
              Investigation warnings <span className="text-muted font-normal">({warnings.length})</span>
            </SectionTitle>
            <ul className="space-y-1.5">
              {warnings.slice(0, 4).map((w, i) => (
                <li key={i} className="text-[11px] text-ink-soft leading-snug flex gap-1.5">
                  <span className="text-warn shrink-0" aria-hidden="true">
                    •
                  </span>
                  {w}
                </li>
              ))}
            </ul>
            {warnings.length > 4 && (
              <Disclose summary={`Show ${warnings.length - 4} more`} className="mt-2">
                <ul className="space-y-1.5">
                  {warnings.slice(4).map((w, i) => (
                    <li key={i} className="text-[11px] text-ink-soft leading-snug flex gap-1.5">
                      <span className="text-warn shrink-0" aria-hidden="true">
                        •
                      </span>
                      {w}
                    </li>
                  ))}
                </ul>
              </Disclose>
            )}
          </div>
        )}

        <p className="text-[10.5px] text-muted leading-relaxed px-1 pb-1">
          SAR dark areas can also be caused by low wind, biogenic films or rain cells. Segmentation is not proof of petroleum.
        </p>
      </div>
    </aside>
  );
};
