/**
 * Scene and data service.
 *
 * Central place where every dataset the web server uses is loaded, with an
 * explicit provenance label. Nothing in here fabricates data: missing
 * products are reported as NOT_AVAILABLE.
 *
 * Detection provenance (never mixed):
 *   MODEL_PREDICTION  polygons vectorised from the frozen U-Net's probability raster on the real SAR scene
 *                     (ml/inference/run_unet_scene.py). This is the ONLY geometry that drives the investigation.
 *   REFERENCE_LABEL   polygons vectorised from the labelled dataset mask. Evaluation only: shown as an
 *                     optional overlay, never used as a detection and never presented as model output.
 *   DERIVED_GEOMETRY  area/perimeter/axis computed from a MODEL_PREDICTION polygon set.
 */

import fs from "fs";
import path from "path";
import {
  LonLat,
  LatLon,
  ringAreaKm2,
  ringPerimeterKm,
  ringPrincipalAxis,
  round,
} from "./geo";
import { EnvironmentModel, FieldSource, loadGriddedField, sampleField, describeSource } from "./environment";
import { parseMarineCadastreCsv, parseDemoAisJson, groupTracks, VesselTrack, parseCsv } from "./ais";
import { dataRoot, resolveData } from "./dataroot";
import { getUpload, listUploads, UploadRecord } from "./uploads";

export const REAL_SCENE_ID = "GOM_S1A_20180926_REAL";

/** Acquisition time recorded by the 2018 offline analysis (ml/inference/attribution.py used 14:24:00). Not read from the raster (it carries no time tag). */
const REAL_SCENE_TIME = "2018-09-26T14:23:49Z";
const INFERENCE_DIR = ["ml", "results", "inference", "2018_09_26"];

export type DataStatus =
  | "REAL"
  | "REAL_DERIVED"
  | "REFERENCE_LABEL"
  | "MODEL_PREDICTION"
  | "DERIVED_GEOMETRY"
  | "SYNTHETIC_DEMO"
  | "NOT_AVAILABLE";

export interface SceneRecord {
  scene_id: string;
  name: string;
  region: string;
  acquisition_time: string;
  acquisition_time_source?: string;
  satellite: string;
  polarization: string;
  bbox: [number, number, number, number];
  bbox_source?: string;
  center_lat: number;
  center_lon: number;
  environmental: {
    current_uo_ms: number | null;
    current_vo_ms: number | null;
    wind_u10_ms: number | null;
    wind_v10_ms: number | null;
    wave_height_m: number | null;
    sea_temp_c: number | null;
  };
  data_source?: string;
  real_data: boolean;
  synthetic: boolean;
  data_status: DataStatus;
  ml_model?: string;
  ml_dataset?: string;
  notes: string[];
}

export interface DetectionGeometry {
  has_detection: boolean;
  centroid: LatLon;
  area_km2: number;
  area_hectares: number;
  perimeter_km: number;
  bbox: [number, number, number, number];
  /** Largest polygon's outer ring (kept for consumers that draw/seed a single ring). */
  coordinates: LonLat[];
  /** Every retained polygon (largest first). `coordinates` === parts[0]. */
  parts: LonLat[][];
  n_components: number | null;
  dropped_small_component_pixels: number | null;
  area_basis: string;
  orientation_deg: number;
  orientation_source: string;
  polygon_principal_axis_deg: number;
  elongation: number;
  confidence: number | null;
  pixel_count: number | null;
}

export interface ReferenceLabelRecord {
  provenance: "REFERENCE_LABEL";
  evaluation_only: true;
  note: string;
  source: Record<string, unknown> | null;
  area_km2: number;
  pixel_count: number;
  centroid: LatLon | null;
  orientation_deg: number | null;
  parts: LonLat[][];
}

export interface DetectionRecord {
  spill_id: number;
  scene_id: string;
  detection_time: string;
  geometry: DetectionGeometry;
  geometry_source: DataStatus;
  geometry_source_detail: string;
  derived_geometry_status?: DataStatus;
  dataset_mode: string;
  polarization: string;
  real_data: boolean;
  synthetic: boolean;
  data_source: string;
  ml_model?: Record<string, unknown>;
  benchmark?: Record<string, unknown>;
  segmentation_quality?: Record<string, unknown>;
  prediction_provenance?: Record<string, unknown> | null;
  reference_label?: ReferenceLabelRecord | null;
  disclaimer: string;
}

function readJson<T = any>(p: string | null, fallback: T): T {
  try {
    if (!p || !fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Scene ids end up in file paths (data/sample/<id>_ais.json): allow only safe characters. */
export function assertSafeSceneId(id: string): string {
  if (typeof id !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(id) || id.includes("..")) {
    throw new Error("Invalid scene id");
  }
  return id;
}

/** SceneRecord for an uploaded, model-scored raster. Everything comes from the stored prediction. */
function uploadedSceneRecord(u: UploadRecord): SceneRecord {
  const g = u.result?.geometry;
  const foot = u.result?.input?.footprint_bbox_lonlat as [number, number, number, number] | undefined;
  const bbox = (foot ?? g?.bbox ?? [0, 0, 0, 0]) as [number, number, number, number];
  const centroid = g?.centroid ?? [(bbox[1] + bbox[3]) / 2, (bbox[0] + bbox[2]) / 2];
  const notes = [
    "Uploaded raster scored with the frozen U-Net checkpoint. No environmental product and no AIS extract exist for this scene.",
    u.observed_at_supplied
      ? "Observation time supplied by the analyst."
      : "No observation time was supplied with the upload; the upload time is used, so drift and any AIS window are relative to that.",
    ...(u.result?.notes ?? []),
  ];
  return {
    scene_id: u.scene_id,
    name: `Uploaded SAR image - ${u.filename}`,
    region: g?.centroid ? "Uploaded scene" : "Uploaded scene (not georeferenced)",
    acquisition_time: u.observed_at,
    acquisition_time_source: u.observed_at_supplied ? "supplied with the upload" : "upload time (no observation time supplied)",
    satellite: "Uploaded raster (sensor not verified)",
    polarization: "unknown",
    bbox,
    bbox_source: foot ? "footprint of the uploaded raster" : "extent of the predicted polygons",
    center_lat: centroid[0],
    center_lon: centroid[1],
    environmental: { current_uo_ms: null, current_vo_ms: null, wind_u10_ms: null, wind_v10_ms: null, wave_height_m: null, sea_temp_c: null },
    data_source: `Uploaded file ${u.filename} (${(u.bytes / 1e6).toFixed(1)} MB), scored by ml/inference/predict_upload.py`,
    real_data: true,
    synthetic: false,
    data_status: g?.polygons?.length ? "MODEL_PREDICTION" : "NOT_AVAILABLE",
    ml_model: "U-Net (ml/checkpoints/unet_oil_spill_best.pth)",
    notes,
  };
}

export class SceneService {
  readonly root: string;
  private envCache = new Map<string, EnvironmentModel>();
  private aisCache = new Map<string, { tracks: VesselTrack[]; label: string; bbox: [number, number, number, number] | null; records: number; synthetic: boolean; file: string; source_type: string }>();
  private inferenceCache: { prediction: any; reference: any; variant: string } | null = null;
  private spillCounter = 1;

  constructor(root: string) {
    this.root = root;
  }

  /** Project-local path. */
  p(...parts: string[]): string {
    return path.join(this.root, ...parts);
  }

  /** Data path: external AEGIS_DATA_ROOT first, then the project. Falls back to the project path (which may not exist). */
  d(...parts: string[]): string {
    return resolveData(this.root, ...parts) ?? this.p(...parts);
  }

  /** Path for display/provenance: never prints the absolute location of the external data root. */
  displayPath(abs: string): string {
    const r = dataRoot();
    if (r && abs.startsWith(r)) return "$AEGIS_DATA_ROOT/" + path.relative(r, abs);
    return path.relative(this.root, abs);
  }

  private exists(...parts: string[]): boolean {
    return resolveData(this.root, ...parts) !== null;
  }

  // ------------------------------------------------------- model prediction + reference label (real scene)
  realInference(): { prediction: any; reference: any; variant: string } {
    if (this.inferenceCache) return this.inferenceCache;
    const variant = process.env.AEGIS_UNET_VARIANT === "patch" ? "patch" : "scene";
    this.inferenceCache = {
      variant,
      prediction: readJson(this.p(...INFERENCE_DIR, `unet_geometry_${variant}.json`), null),
      reference: readJson(this.p(...INFERENCE_DIR, "reference_label_geometry.json"), null),
    };
    return this.inferenceCache;
  }

  /** Bounding box of the scene, from data only: raster footprint > AIS extract > ERA5 grid. */
  private sceneBbox(): { bbox: [number, number, number, number]; source: string } {
    const foot = this.realInference().prediction?.source_raster?.footprint_bbox_lonlat;
    if (Array.isArray(foot) && foot.length === 4) return { bbox: foot as [number, number, number, number], source: "footprint of the real SAR raster (EPSG:32616 corners -> WGS84)" };
    const a = this.ais(REAL_SCENE_ID);
    if (a.bbox) return { bbox: a.bbox, source: "extent of the AIS extract" };
    const w = this.environment(REAL_SCENE_ID).wind;
    if (w.kind === "gridded") {
      const f = w.field;
      return { bbox: [Math.min(...f.lons), Math.min(...f.lats), Math.max(...f.lons), Math.max(...f.lats)], source: "extent of the ERA5 wind grid" };
    }
    return { bbox: [0, 0, 0, 0], source: "unknown" };
  }

  // ---------------------------------------------------------------- scenes
  realScene(): SceneRecord {
    const env = this.environment(REAL_SCENE_ID);
    const t0 = Date.parse(REAL_SCENE_TIME);
    const { bbox, source } = this.sceneBbox();
    const pred = this.realInference().prediction;
    const centerLat: number = pred?.centroid?.[0] ?? (bbox[1] + bbox[3]) / 2;
    const centerLon: number = pred?.centroid?.[1] ?? (bbox[0] + bbox[2]) / 2;
    const w = sampleField(env.wind, centerLat, centerLon, t0);
    const c = sampleField(env.current, centerLat, centerLon, t0);
    const notes = [
      "Wind: ERA5 u10/v10, 14:00 and 15:00 UTC only (2 hourly fields); outside that window the nearest field is held constant and labelled PERSISTED.",
      c.status === "NOT_AVAILABLE"
        ? "Ocean current: CURRENT_DATA_UNAVAILABLE / NOT_ASSESSED — no historical current product is connected for this scene (no value is invented)."
        : "Ocean current: gridded product connected (see environment sources).",
      "Wave height and SST: not available (NOT_ASSESSED).",
      pred
        ? "Slick geometry: MODEL_PREDICTION from the frozen U-Net run on the real SAR scene."
        : "Slick geometry: NOT_AVAILABLE — run ml/inference/run_unet_scene.py (the labelled reference mask is evaluation-only and is not used as a detection).",
    ];
    return {
      scene_id: REAL_SCENE_ID,
      name: "Sentinel-1A Oil Spill Benchmark — 26 Sep 2018",
      region: "Northern Gulf of Mexico",
      acquisition_time: REAL_SCENE_TIME,
      acquisition_time_source: "recorded by the 2018 offline analysis; the SAR raster carries no time tag",
      satellite: "Sentinel-1A",
      polarization: "VV",
      bbox,
      bbox_source: source,
      center_lat: centerLat,
      center_lon: centerLon,
      environmental: {
        current_uo_ms: c.status === "NOT_AVAILABLE" ? null : round(c.u, 3),
        current_vo_ms: c.status === "NOT_AVAILABLE" ? null : round(c.v, 3),
        wind_u10_ms: w.status === "NOT_AVAILABLE" ? null : round(w.u, 3),
        wind_v10_ms: w.status === "NOT_AVAILABLE" ? null : round(w.v, 3),
        wave_height_m: null,
        sea_temp_c: null,
      },
      data_source: "Sentinel-1 oil-spill dataset (Zenodo 4672426) + NOAA MarineCadastre AIS 2018 + ECMWF ERA5",
      real_data: true,
      synthetic: false,
      data_status: pred ? "REAL" : "NOT_AVAILABLE",
      ml_model: "U-Net (ml/checkpoints/unet_oil_spill_best.pth)",
      ml_dataset: "Sentinel-1 oil-spill dataset / Zenodo 4672426",
      notes,
    };
  }

  demoScenes(): SceneRecord[] {
    const catalog = readJson<any[]>(this.p("data", "sample", "scenes_catalog.json"), []);
    return (Array.isArray(catalog) ? catalog : []).map((s) => ({
      scene_id: s.scene_id,
      name: `${s.name} [SYNTHETIC DEMO]`,
      region: s.region,
      acquisition_time: s.acquisition_time,
      satellite: `${s.satellite} (synthetic scene)`,
      polarization: s.polarization,
      bbox: s.bbox,
      center_lat: s.center_lat,
      center_lon: s.center_lon,
      environmental: {
        current_uo_ms: s.environmental?.current_uo_ms ?? null,
        current_vo_ms: s.environmental?.current_vo_ms ?? null,
        wind_u10_ms: s.environmental?.wind_u10_ms ?? null,
        wind_v10_ms: s.environmental?.wind_v10_ms ?? null,
        wave_height_m: s.environmental?.wave_height_m ?? null,
        sea_temp_c: s.environmental?.sea_temp_c ?? null,
      },
      data_source: "SYNTHETIC — generated by scripts/generate_sample_data.py",
      real_data: false,
      synthetic: true,
      data_status: "SYNTHETIC_DEMO" as DataStatus,
      notes: [
        "Entire scene is synthetic: slick, environment constants and AIS tracks are generated.",
        "Vessel names are fictitious and marked [SYNTHETIC]; synthetic IMO numbers are suppressed.",
      ],
    }));
  }

  listScenes(): SceneRecord[] {
    return [
      this.realScene(),
      ...this.demoScenes().filter((s) => s.scene_id !== REAL_SCENE_ID),
      ...listUploads().map(uploadedSceneRecord),
    ];
  }

  /** The upload behind an UPLOAD_<id> scene id, if any. */
  private upload(sceneId: string): UploadRecord | undefined {
    return sceneId.startsWith("UPLOAD_") ? getUpload(sceneId.slice("UPLOAD_".length)) : undefined;
  }

  getScene(id: string): SceneRecord | null {
    return this.listScenes().find((s) => s.scene_id === id) ?? null;
  }

  // ---------------------------------------------------------------- detection
  private referenceRecord(ref: any): ReferenceLabelRecord | null {
    if (!ref || !Array.isArray(ref.polygons) || !ref.polygons.length) return null;
    return {
      provenance: "REFERENCE_LABEL",
      evaluation_only: true,
      note: "Labelled reference mask of the dataset (annotations from NOAA reports), vectorised. Used ONLY to evaluate the model. It is not a model prediction and does not drive the investigation.",
      source: ref.source_mask ?? null,
      area_km2: ref.total_area_km2,
      pixel_count: ref.total_pixel_count,
      centroid: ref.centroid ?? null,
      orientation_deg: ref.orientation_deg ?? null,
      parts: ref.polygons.map((q: any) => q.ring as LonLat[]),
    };
  }

  detect(sceneId: string, polarization = "VV"): DetectionRecord {
    assertSafeSceneId(sceneId);
    const scene = this.getScene(sceneId);
    if (!scene) throw new Error(`Scene not found: ${sceneId}`);
    const spillId = this.spillCounter++;

    const up = this.upload(sceneId);
    if (up) {
      const g = up.result?.geometry;
      const parts: LonLat[][] = (g?.polygons ?? []).map((q: any) => q.ring as LonLat[]);
      const pred = up.result?.prediction ?? {};
      const model = up.result?.model ?? {};
      const common = {
        spill_id: spillId,
        scene_id: sceneId,
        detection_time: scene.acquisition_time,
        dataset_mode: "UPLOAD",
        polarization,
        real_data: true,
        synthetic: false,
        data_source: scene.data_source ?? "Uploaded raster",
        reference_label: null,
      };
      if (!parts.length) {
        return {
          ...common,
          geometry: {
            has_detection: false, centroid: [scene.center_lat, scene.center_lon], area_km2: 0, area_hectares: 0, perimeter_km: 0,
            bbox: scene.bbox, coordinates: [], parts: [], n_components: pred.connected_components ?? null,
            dropped_small_component_pixels: pred.pixels_dropped_as_specks ?? null, area_basis: "no georeferenced prediction",
            orientation_deg: 0, orientation_source: "n/a", polygon_principal_axis_deg: 0, elongation: 0, confidence: null,
            pixel_count: pred.positive_pixels ?? null,
          },
          geometry_source: "NOT_AVAILABLE",
          geometry_source_detail: up.result?.input?.georeferenced === false
            ? "The uploaded raster has no CRS, so the prediction cannot be placed on the map or measured in km². Pixel counts only."
            : "The model produced no slick polygons above the size filter for this upload.",
          prediction_provenance: { provenance: "MODEL_PREDICTION", model, inference: model, created_utc: up.result?.created_utc },
          disclaimer: "No mappable detection was produced for this upload, so no drift or attribution is computed.",
        };
      }
      const ring = parts[0];
      const pa = ringPrincipalAxis(ring);
      const perimeter = parts.reduce((acc, r) => acc + ringPerimeterKm(r), 0);
      const totalKm2 = pred.area_km2 ?? g.total_area_km2 ?? 0;
      return {
        ...common,
        geometry: {
          has_detection: true,
          centroid: g.centroid,
          area_km2: round(totalKm2, 3),
          area_hectares: round(totalKm2 * 100, 1),
          perimeter_km: round(perimeter, 2),
          bbox: g.bbox,
          coordinates: ring,
          parts,
          n_components: g.n_connected_components ?? null,
          dropped_small_component_pixels: g.dropped_small_component_pixels ?? null,
          area_basis: "predicted-pixel count x pixel area of the uploaded raster",
          orientation_deg: g.orientation_deg ?? round(pa.axis_deg, 1),
          orientation_source: g.orientation_source ?? "polygon second moments",
          polygon_principal_axis_deg: round(pa.axis_deg, 1),
          elongation: round(pa.elongation, 2),
          confidence: null,
          pixel_count: pred.pixels_in_kept_components ?? g.total_pixel_count ?? null,
        },
        geometry_source: "MODEL_PREDICTION",
        geometry_source_detail:
          `Frozen U-Net (checkpoint ${String(model.checkpoint_sha256 ?? "").slice(0, 8)}…) run on the uploaded raster ` +
          `${up.filename} (${up.result?.input?.width}x${up.result?.input?.height}, ${up.result?.input?.crs ?? "no CRS"}): ` +
          `${model.normalization}, ${model.tiling}, threshold ${model.threshold}; ` +
          `${parts.length} polygons kept of ${g.n_connected_components} components. ` +
          (up.result?.input?.in_training_value_range === false
            ? "WARNING: pixel values lie outside the Sentinel-1 VV dB range the model was trained on, so this result is out-of-distribution."
            : ""),
        derived_geometry_status: "DERIVED_GEOMETRY",
        prediction_provenance: { provenance: "MODEL_PREDICTION", model, inference: model, source_raster: up.result?.input, prediction_stats: pred, created_utc: up.result?.created_utc },
        ml_model: { name: "U-Net", checkpoint: model.checkpoint, checkpoint_sha256: model.checkpoint_sha256, checkpoint_epoch: model.epoch },
        segmentation_quality: {
          scene_dice_vs_label: null,
          scene_metrics_provenance: "NOT_MEASURED (no reference label exists for an uploaded image)",
          note: "Segmentation quality cannot be measured for an uploaded image because there is no labelled mask to compare against.",
          probability_max: pred.max_probability ?? null,
          probability_is_calibrated: false,
        },
        disclaimer:
          "SAR dark areas can be caused by look-alikes (low wind, biogenic films, rain cells). This is a model prediction on an uploaded raster, " +
          "not proof of petroleum, and the sensor and calibration of the upload were not verified.",
      };
    }

    if (sceneId === REAL_SCENE_ID) {
      const inf = this.realInference();
      const pred = inf.prediction;
      const reference = this.referenceRecord(inf.reference);
      const registry = this.modelRegistry();
      const baseline = registry?.models?.find((m: any) => m.role === "production-baseline");
      const stored = baseline?.test_metrics?.per_scene?.["2018_09_26.tif"];
      const fresh = readJson<any>(this.p("ml", "results", "eval_baseline.json"), null);
      const measured = pred?.measured_vs_reference_label ?? null;

      const common = {
        spill_id: spillId,
        scene_id: sceneId,
        detection_time: scene.acquisition_time,
        dataset_mode: "REAL",
        polarization,
        real_data: true,
        synthetic: false,
        data_source: "Sentinel-1 oil-spill dataset / Zenodo 4672426 (test scene 2018_09_26.tif; identical raster to the held-out test image)",
        reference_label: reference,
      };

      if (!pred || !Array.isArray(pred.polygons) || !pred.polygons.length) {
        return {
          ...common,
          geometry: {
            has_detection: false,
            centroid: [scene.center_lat, scene.center_lon],
            area_km2: 0,
            area_hectares: 0,
            perimeter_km: 0,
            bbox: scene.bbox,
            coordinates: [],
            parts: [],
            n_components: null,
            dropped_small_component_pixels: null,
            area_basis: "no model prediction",
            orientation_deg: 0,
            orientation_source: "n/a",
            polygon_principal_axis_deg: 0,
            elongation: 0,
            confidence: null,
            pixel_count: null,
          },
          geometry_source: "NOT_AVAILABLE",
          geometry_source_detail:
            "MODEL_PREDICTION_UNAVAILABLE: no U-Net prediction file found (ml/results/inference/2018_09_26/unet_geometry_scene.json). Run `python ml/inference/run_unet_scene.py`. The labelled reference mask is evaluation-only and is deliberately NOT used as a detection.",
          prediction_provenance: null,
          disclaimer: "No model prediction is available for this scene, so no slick geometry, drift or attribution is produced.",
        };
      }

      const parts: LonLat[][] = pred.polygons.map((q: any) => q.ring as LonLat[]);
      const ring = parts[0];
      const pa = ringPrincipalAxis(ring);
      const perimeter = parts.reduce((s, r) => s + ringPerimeterKm(r), 0);
      const totalKm2: number = pred.total_area_km2;
      const norm = pred.inference?.normalization ?? inf.variant;
      const detail =
        `U-Net (frozen checkpoint ${String(pred.model?.checkpoint_sha256 ?? "").slice(0, 8)}…, epoch ${pred.model?.epoch ?? "?"}) run on the real Sentinel-1 scene ${pred.source_raster?.file} ` +
        `(${pred.source_raster?.crs}, ${pred.source_raster?.pixel_size_m} m): ${norm}-normalised, ${pred.inference?.tiling}, threshold ${pred.inference?.threshold}; ` +
        `${parts.length} polygons kept of ${pred.n_connected_components} connected components (${pred.dropped_small_component_pixels} px of specks < ${pred.min_component_area_px} px dropped); ` +
        `vectorised by ml/inference/run_unet_scene.py.`;

      const quality = {
        scene_dice_vs_label: measured?.dice ?? null,
        scene_iou_vs_label: measured?.iou ?? null,
        scene_precision_vs_label: measured?.precision ?? null,
        scene_recall_vs_label: measured?.recall ?? null,
        scene_metrics_provenance: measured ? "MEASURED_THIS_RUN (this checkpoint, this scene, this protocol, against the REFERENCE_LABEL)" : "NOT_MEASURED",
        stored_historical_scene_dice: stored?.dice ?? null,
        stored_historical_provenance: "STORED_HISTORICAL (ml/model_registry.json; historic test protocol)",
        fresh_test_set_mean_dice_historic_protocol: fresh?.historic_protocol?.macro_mean?.dice ?? null,
        fresh_test_set_mean_dice_scene_overlap_protocol: fresh?.scene_overlap_protocol?.macro_mean?.dice ?? null,
        fresh_test_set_provenance: fresh ? "MEASURED (ml/results/eval_baseline.json)" : "NOT_MEASURED",
        test_set_mean_dice: fresh?.scene_overlap_protocol?.macro_mean?.dice ?? baseline?.test_metrics?.mean_dice ?? null,
        validation_dice: baseline?.validation_metrics?.dice ?? null,
        validation_note: "Stored validation Dice is optimistic: the validation CSV samples patches from the same 14 source scenes as the training CSV.",
        note: "This scene is the best of the 7 held-out test scenes (per-scene Dice 0.002–0.85 under the scene-normalised protocol). Test-set mean Dice is the representative figure.",
      };

      return {
        ...common,
        geometry: {
          has_detection: true,
          centroid: pred.centroid,
          area_km2: round(totalKm2, 3),
          area_hectares: round(totalKm2 * 100, 1),
          perimeter_km: round(perimeter, 2),
          bbox: pred.bbox,
          coordinates: ring,
          parts,
          n_components: pred.n_connected_components ?? null,
          dropped_small_component_pixels: pred.dropped_small_component_pixels ?? null,
          area_basis: "predicted-pixel count x 100 m² (10 m pixels)",
          orientation_deg: pred.orientation_deg ?? round(pa.axis_deg, 1),
          orientation_source: pred.orientation_source ?? "polygon second moments",
          polygon_principal_axis_deg: round(pa.axis_deg, 1),
          elongation: round(pa.elongation, 2),
          confidence: null,
          pixel_count: pred.total_pixel_count,
        },
        geometry_source: "MODEL_PREDICTION",
        geometry_source_detail: detail,
        derived_geometry_status: "DERIVED_GEOMETRY",
        prediction_provenance: {
          provenance: "MODEL_PREDICTION",
          model: pred.model,
          inference: pred.inference,
          source_raster: pred.source_raster,
          prediction_stats: pred.prediction_stats,
          created_utc: pred.created_utc,
        },
        ml_model: {
          name: "U-Net",
          architecture: "4-level U-Net, bilinear upsampling, 1-channel VV input",
          checkpoint: "ml/checkpoints/unet_oil_spill_best.pth",
          checkpoint_sha256: pred.model?.checkpoint_sha256 ?? null,
          checkpoint_epoch: baseline?.checkpoint?.epoch ?? null,
          training_dataset: "Sentinel-1 oil-spill dataset (Zenodo 4672426)",
          best_validation_dice: baseline?.validation_metrics?.dice ?? null,
          best_validation_iou: baseline?.validation_metrics?.iou ?? null,
        },
        benchmark: {
          test_scene: "2018_09_26.tif",
          provenance: measured ? "MEASURED_THIS_RUN" : "STORED_HISTORICAL",
          dice: measured?.dice ?? stored?.dice ?? null,
          iou: measured?.iou ?? stored?.iou ?? null,
          precision: measured?.precision ?? stored?.precision ?? null,
          recall: measured?.recall ?? stored?.recall ?? null,
          stored_historical: stored ?? null,
        },
        segmentation_quality: quality,
        disclaimer:
          "SAR dark areas can be caused by look-alikes (low wind, biogenic films, rain cells, current shear). Segmentation is not proof of petroleum. " +
          "The displayed outline is the vectorised U-Net prediction (MODEL_PREDICTION); the labelled reference mask is a separate, evaluation-only overlay.",
      };
    }

    // ------------------------- synthetic demo slick
    const cat = readJson<any[]>(this.p("data", "sample", "scenes_catalog.json"), []).find((s) => s.scene_id === sceneId);
    const [minLon, minLat, maxLon, maxLat] = scene.bbox;
    const cLat = cat?.spill_ground_truth?.synthetic_center_lat ?? (minLat + maxLat) / 2;
    const cLon = cat?.spill_ground_truth?.synthetic_center_lon ?? (minLon + maxLon) / 2;
    const ring: LonLat[] = [];
    const rLat = 0.018, rLon = 0.042, rot = 0.61;
    for (let i = 0; i < 24; i++) {
      const th = (2 * Math.PI * i) / 24;
      const dx = rLon * Math.cos(th) * (1 + 0.15 * Math.sin(3 * th));
      const dy = rLat * Math.sin(th) * (1 + 0.12 * Math.cos(2 * th));
      ring.push([round(cLon + dx * Math.cos(rot) - dy * Math.sin(rot), 6), round(cLat + dx * Math.sin(rot) + dy * Math.cos(rot), 6)]);
    }
    ring.push(ring[0]);
    const pa = ringPrincipalAxis(ring);
    const area = ringAreaKm2(ring);
    return {
      spill_id: spillId,
      scene_id: sceneId,
      detection_time: scene.acquisition_time,
      geometry: {
        has_detection: true,
        centroid: [round(cLat, 6), round(cLon, 6)],
        area_km2: round(area, 3),
        area_hectares: round(area * 100, 1),
        perimeter_km: round(ringPerimeterKm(ring), 2),
        bbox: bboxOf(ring),
        coordinates: ring,
        parts: [ring],
        n_components: 1,
        dropped_small_component_pixels: null,
        area_basis: "synthetic polygon area",
        orientation_deg: round(pa.axis_deg, 1),
        orientation_source: "synthetic polygon second moments",
        polygon_principal_axis_deg: round(pa.axis_deg, 1),
        elongation: round(pa.elongation, 2),
        confidence: null,
        pixel_count: null,
      },
      geometry_source: "SYNTHETIC_DEMO",
      geometry_source_detail: "Synthetic ellipse generated for the demo scene. No SAR image or model inference is involved.",
      dataset_mode: "DEMO",
      polarization,
      real_data: false,
      synthetic: true,
      data_source: "SYNTHETIC demo scene",
      reference_label: null,
      prediction_provenance: null,
      disclaimer: "SYNTHETIC DEMO DETECTION — for interface demonstration only.",
    };
  }

  // ---------------------------------------------------------------- environment
  /** First existing ocean-current file for the scene (data/currents/ or data/cmems/), else null. */
  private currentFile(sceneId: string): string | null {
    for (const dir of ["currents", "cmems"]) {
      const r = resolveData(this.root, "data", dir, `${sceneId}_currents.json`);
      if (r) return r;
    }
    return null;
  }

  environment(sceneId: string): EnvironmentModel {
    assertSafeSceneId(sceneId);
    const cached = this.envCache.get(sceneId);
    if (cached) return cached;
    if (this.upload(sceneId)) {
      const m: EnvironmentModel = {
        wind: { kind: "none", label: "No wind product for an uploaded scene (NOT_ASSESSED)" },
        current: { kind: "none", label: "CURRENT_DATA_UNAVAILABLE / NOT_ASSESSED for an uploaded scene" },
      };
      this.envCache.set(sceneId, m);
      return m;
    }
    let model: EnvironmentModel;
    const currentFile = this.currentFile(sceneId);
    let current: FieldSource = currentFile
      ? loadGriddedField(currentFile, "Ocean surface current (uo, vo)")
      : { kind: "none", label: "CURRENT_DATA_UNAVAILABLE / NOT_ASSESSED: no historical current product connected for this scene" };
    if (current.kind === "gridded") {
      // name the product and say what it is, from the field's own provenance
      const pv: any = current.field.provenance ?? {};
      current = { ...current, label: `Ocean surface current (uo, vo): ${pv.product ?? current.field.source}${pv.is_observation === false ? " - model analysis, not observations" : ""}` };
    }
    if (sceneId === REAL_SCENE_ID) {
      model = {
        wind: loadGriddedField(this.d("data", "era5", "era5_2018-09-26_field.json"), "ERA5 10 m wind (u10, v10)"),
        current,
      };
    } else {
      const cat = readJson<any[]>(this.p("data", "sample", "scenes_catalog.json"), []).find((s) => s.scene_id === sceneId);
      const e = cat?.environmental ?? {};
      model = {
        wind: Number.isFinite(e.wind_u10_ms) && Number.isFinite(e.wind_v10_ms)
          ? { kind: "constant", u: e.wind_u10_ms, v: e.wind_v10_ms, status: "DEMO_CONSTANT", label: "Synthetic demo wind constant" }
          : { kind: "none", label: "No wind for demo scene" },
        current: current.kind !== "none"
          ? current
          : Number.isFinite(e.current_uo_ms) && Number.isFinite(e.current_vo_ms)
            ? { kind: "constant", u: e.current_uo_ms, v: e.current_vo_ms, status: "DEMO_CONSTANT", label: "Synthetic demo current constant" }
            : { kind: "none", label: "No current for demo scene" },
      };
    }
    this.envCache.set(sceneId, model);
    return model;
  }

  environmentDescription(sceneId: string) {
    const env = this.environment(sceneId);
    return { wind: describeSource(env.wind), current: describeSource(env.current) };
  }

  // ---------------------------------------------------------------- AIS
  ais(sceneId: string) {
    assertSafeSceneId(sceneId);
    const cached = this.aisCache.get(sceneId);
    if (cached) return cached;
    let entry;
    if (this.upload(sceneId)) {
      entry = { tracks: [], label: "No AIS extract for an uploaded scene", bbox: null, records: 0, synthetic: false, file: "n/a", source_type: "NOT_AVAILABLE" };
      this.aisCache.set(sceneId, entry);
      return entry;
    }
    if (sceneId === REAL_SCENE_ID) {
      const file = this.d("data", "ais", "2018", "ais_2018-09-26_scene.csv");
      if (!fs.existsSync(file)) {
        entry = { tracks: [], label: "MarineCadastre AIS file missing", bbox: null, records: 0, synthetic: false, file: this.displayPath(file), source_type: "UNKNOWN" };
      } else {
        const pts = parseMarineCadastreCsv(fs.readFileSync(file, "utf8"));
        const lons = pts.map((p) => p.lon), lats = pts.map((p) => p.lat);
        entry = {
          tracks: groupTracks(pts),
          label: "NOAA/USCG Nationwide AIS via MarineCadastre 2018 (terrestrial receivers)",
          bbox: pts.length ? ([Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)] as [number, number, number, number]) : null,
          records: pts.length,
          synthetic: false,
          file: this.displayPath(file),
          source_type: "TERRESTRIAL",
        };
      }
    } else {
      const file = this.p("data", "sample", `${sceneId}_ais.json`);
      const pts = parseDemoAisJson(readJson<any[]>(file, []));
      entry = { tracks: groupTracks(pts), label: "SYNTHETIC demo AIS", bbox: null, records: pts.length, synthetic: true, file: path.relative(this.root, file), source_type: "SYNTHETIC" };
    }
    this.aisCache.set(sceneId, entry);
    return entry;
  }

  /** Scores from the 2018 offline analysis (0..100), keyed by MMSI. */
  baseline(sceneId: string): Map<string, number> {
    const out = new Map<string, number>();
    if (sceneId !== REAL_SCENE_ID) return out;
    const file = this.d("data", "ais", "2018", "trajectory_attribution_2018-09-26.csv");
    if (!fs.existsSync(file)) return out;
    for (const r of parseCsv(fs.readFileSync(file, "utf8"))) {
      const s = Number(r.final_attribution_score);
      if (r.mmsi && Number.isFinite(s)) out.set(String(r.mmsi), s);
    }
    return out;
  }

  // ---------------------------------------------------------------- misc
  modelRegistry(): any {
    return readJson<any>(this.p("ml", "model_registry.json"), null);
  }

  /** Absolute path of the real Sentinel-1 VV raster, if this deployment bundles it (else null). */
  realSceneRasterPath(): string | null {
    return resolveData(this.root, "data", "sentinel1", "real", "2018_09_26.tif");
  }

  /**
   * The stored, precomputed MODEL_PREDICTION summary for the real scene: what the frozen U-Net
   * produced offline. Used to compare against a live re-run; never modified by one.
   */
  storedScenePrediction(): Record<string, unknown> | null {
    const g = readJson<any>(this.p(...INFERENCE_DIR, "unet_geometry_scene.json"), null);
    if (!g) return null;
    return {
      provenance: "MODEL_PREDICTION (precomputed offline, bundled with this deployment)",
      created_utc: g.created_utc ?? null,
      predicted_pixels: g.prediction_stats?.predicted_pixels ?? null,
      max_probability: g.prediction_stats?.max_probability ?? null,
      total_area_km2: g.total_area_km2 ?? null,
      n_connected_components: g.n_connected_components ?? null,
      polygons_kept: Array.isArray(g.polygons) ? g.polygons.length : null,
      checkpoint_sha256: g.model?.checkpoint_sha256 ?? null,
      inference: g.inference ?? null,
      source_raster: g.source_raster ?? null,
    };
  }

  assets(sceneId: string): { name: string; file: string; description: string; georeferenced: boolean }[] {
    if (sceneId !== REAL_SCENE_ID) return [];
    const dir = this.p("data", "sentinel1", "derived");
    const manifest = readJson<any[]>(path.join(dir, "manifest.json"), []);
    return manifest.filter((a) => fs.existsSync(path.join(dir, a.file)));
  }

  assetPath(sceneId: string, name: string): string | null {
    const a = this.assets(sceneId).find((x) => x.name === name);
    return a ? this.p("data", "sentinel1", "derived", a.file) : null;
  }

  dataInventory() {
    const check = (rel: string, role: string, project = false) => ({
      file: rel,
      role,
      present: project ? fs.existsSync(this.p(...rel.split("/"))) : this.exists(...rel.split("/")),
    });
    return [
      check("data/sentinel1/real/2018_09_26.tif", "Real SAR raster (input to live U-Net inference)"),
      check("ml/datasets/radar_data/Radar_data/test/masks/2018_09_26.tif", "Reference label mask (evaluation only)"),
      check("ml/results/inference/2018_09_26/unet_geometry_scene.json", "U-Net prediction polygons (MODEL_PREDICTION)", true),
      check("ml/results/inference/2018_09_26/reference_label_geometry.json", "Reference-label polygons (REFERENCE_LABEL, evaluation only)", true),
      check("data/era5/era5_2018-09-26.nc", "ERA5 source NetCDF"),
      check("data/era5/era5_2018-09-26_field.json", "ERA5 wind field used by the drift engine"),
      check("data/ais/2018/ais_2018-09-26_scene.csv", "MarineCadastre AIS extract (raw)"),
      check("data/ais/2018/trajectory_attribution_2018-09-26.csv", "2018 offline attribution baseline"),
      check("ml/checkpoints/unet_oil_spill_best.pth", "U-Net baseline checkpoint", true),
      check("ml/model_registry.json", "Model registry", true),
      { file: `data/currents/${REAL_SCENE_ID}_currents.json`, role: "Ocean-current field (CURRENT_DATA_UNAVAILABLE if absent)", present: this.currentFile(REAL_SCENE_ID) !== null },
      check("data/sample/scenes_catalog.json", "Synthetic demo scene catalogue", true),
    ];
  }
}

function bboxOf(ring: LonLat[]): [number, number, number, number] {
  const lons = ring.map((p) => p[0]);
  const lats = ring.map((p) => p[1]);
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
}
