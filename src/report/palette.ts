/**
 * Colour semantics for the incident report. One dimension = one palette, and
 * every coloured element also carries a text label (colour is never the only
 * carrier of meaning, so the report survives greyscale printing).
 *
 *  Provenance   REAL green | MODEL PREDICTION / DERIVED GEOMETRY indigo
 *               | PERSISTED / EDGE-CLAMPED / REFERENCE LABEL amber (caution)
 *               | FALLBACK/DEMO purple | NOT AVAILABLE / LAND grey
 *  Risk         traffic light: LOW green .. SEVERE red (used ONLY for risk and
 *               action urgency)
 *  Evidence     single-hue blue scale (STRONG dark .. WEAK pale): evidence is
 *               never drawn in "alarm" colours
 *  Uncertainty  neutral slate scale, darker = MORE uncertain; deliberately not
 *               green/red so uncertainty never reads as good/bad or certain
 *  Warnings     amber callouts; unavailable data grey + italic "not available"
 *
 * Rule: when attribution uncertainty is HIGH, score bars are drawn hollow so a
 * high score never looks like a confident result.
 */

import type { RGB } from "./pdfWriter";

export interface ChipStyle { fill: RGB; text: RGB; outline?: boolean }

/**
 * Hedged rendering for evidence/score chips whose associated uncertainty is
 * HIGH: drawn as an outline (white fill, coloured border) instead of solid, so
 * colour never makes an uncertain result look confident.
 */
export function hedged(style: ChipStyle, uncertainty: string | null | undefined): ChipStyle {
  return uncertainty === "HIGH" ? { ...style, outline: true } : style;
}

export const INK: RGB = [36, 41, 47];
export const MUTED: RGB = [87, 96, 106];
export const RULE: RGB = [208, 215, 222];
export const PANEL: RGB = [246, 248, 250];
export const BRAND: RGB = [13, 17, 23];

const WHITE: RGB = [255, 255, 255];
const BLACK: RGB = [24, 24, 24];

export type ProvCategory =
  | "REAL" | "REAL-DERIVED" | "PERSISTED" | "EDGE-CLAMPED" | "PERSISTED+EDGE"
  | "MODEL PREDICTION" | "DERIVED GEOMETRY" | "REFERENCE LABEL" | "LAND/NO DATA"
  | "FALLBACK/DEMO" | "USER OVERRIDE" | "NOT AVAILABLE";

export function provenanceCategory(status?: string | null): ProvCategory {
  switch (String(status ?? "")) {
    case "REAL": return "REAL";
    case "REAL_DERIVED": return "REAL-DERIVED";
    case "PERSISTED": return "PERSISTED";
    case "EDGE_CLAMPED": return "EDGE-CLAMPED";
    case "PERSISTED+EDGE_CLAMPED": return "PERSISTED+EDGE";
    case "MODEL_PREDICTION": return "MODEL PREDICTION";
    case "DERIVED_GEOMETRY": return "DERIVED GEOMETRY";
    case "REFERENCE_LABEL": return "REFERENCE LABEL";
    case "LAND_OR_NO_DATA": return "LAND/NO DATA";
    case "DEMO_CONSTANT": case "SYNTHETIC_DEMO": case "SYNTHETIC": return "FALLBACK/DEMO";
    case "USER_OVERRIDE": return "USER OVERRIDE";
    default: return "NOT AVAILABLE";
  }
}

export const PROVENANCE: Record<ProvCategory, ChipStyle> = {
  "REAL": { fill: [26, 127, 55], text: WHITE },
  "REAL-DERIVED": { fill: [45, 164, 78], text: WHITE },
  "PERSISTED": { fill: [212, 167, 44], text: BLACK },
  "EDGE-CLAMPED": { fill: [212, 167, 44], text: BLACK },
  "PERSISTED+EDGE": { fill: [212, 167, 44], text: BLACK },
  // model output is its own provenance class (indigo): never green (real observation) and never the label colour
  "MODEL PREDICTION": { fill: [62, 84, 160], text: WHITE },
  "DERIVED GEOMETRY": { fill: [128, 146, 210], text: BLACK },
  // labelled reference mask: evaluation-only (amber = caution, do not read as a prediction)
  "REFERENCE LABEL": { fill: [212, 167, 44], text: BLACK },
  "LAND/NO DATA": { fill: [110, 119, 129], text: WHITE },
  "FALLBACK/DEMO": { fill: [130, 80, 223], text: WHITE },
  "USER OVERRIDE": { fill: [130, 80, 223], text: WHITE },
  "NOT AVAILABLE": { fill: [110, 119, 129], text: WHITE },
};

export const RISK: Record<string, ChipStyle> = {
  LOW: { fill: [26, 127, 55], text: WHITE },
  MODERATE: { fill: [212, 167, 44], text: BLACK },
  HIGH: { fill: [219, 109, 40], text: WHITE },
  SEVERE: { fill: [207, 34, 46], text: WHITE },
  UNKNOWN: { fill: [110, 119, 129], text: WHITE },
};

export const URGENCY: Record<string, ChipStyle> = {
  IMMEDIATE: RISK.SEVERE,
  HIGH: RISK.HIGH,
  ROUTINE: { fill: [216, 222, 228], text: INK },
};

export const EVIDENCE: Record<string, ChipStyle> = {
  STRONG: { fill: [9, 105, 218], text: WHITE },
  MODERATE: { fill: [84, 174, 255], text: BLACK },
  WEAK: { fill: [182, 227, 255], text: BLACK },
  NONE: { fill: [234, 238, 242], text: MUTED },
};
/** Bar colour for a 0..1 evidence / score value (blue scale). */
export function evidenceBar(v: number): RGB {
  return v >= 0.75 ? EVIDENCE.STRONG.fill : v >= 0.5 ? EVIDENCE.MODERATE.fill : v >= 0.25 ? EVIDENCE.WEAK.fill : [200, 208, 216];
}

export const UNCERTAINTY: Record<string, ChipStyle> = {
  LOW: { fill: [216, 222, 228], text: INK },
  MEDIUM: { fill: [140, 149, 159], text: WHITE },
  HIGH: { fill: [66, 74, 83], text: WHITE },
  "N/A": { fill: [246, 248, 250], text: MUTED },
};

export const NODE_STATUS: Record<string, ChipStyle> = {
  completed: { fill: [218, 251, 225], text: [26, 127, 55] },
  failed: { fill: [255, 235, 233], text: [207, 34, 46] },
  skipped: { fill: [234, 238, 242], text: MUTED },
  running: { fill: [221, 244, 255], text: [9, 105, 218] },
  pending: { fill: [234, 238, 242], text: MUTED },
};

export const CALLOUT = {
  warning: { bg: [255, 248, 197] as RGB, border: [212, 167, 44] as RGB, title: [122, 86, 0] as RGB },
  unavailable: { bg: [246, 248, 250] as RGB, border: [140, 149, 159] as RGB, title: MUTED },
  disclaimer: { bg: [240, 242, 245] as RGB, border: BRAND, title: BRAND },
  demo: { bg: [251, 239, 255] as RGB, border: [130, 80, 223] as RGB, title: [99, 56, 181] as RGB },
  info: { bg: [221, 244, 255] as RGB, border: [84, 174, 255] as RGB, title: [9, 105, 218] as RGB },
};

/** Map symbology (report map only). Forecast horizons use a sequential teal->navy
 *  ramp (time progression), NOT traffic-light colours, so later horizons do not
 *  read as "more severe" or "more certain". */
export const MAP = {
  sea: [238, 244, 248] as RGB,
  grid: [205, 216, 226] as RGB,
  slick: [207, 34, 46] as RGB,
  origin: [140, 90, 43] as RGB,
  vessel: [87, 96, 106] as RGB,
  vesselTop: [24, 24, 24] as RGB,
  selected: [9, 105, 218] as RGB,
  wind: [191, 135, 0] as RGB,
  current: [0, 128, 128] as RGB,
  horizon: { 6: [65, 182, 196], 12: [29, 145, 192], 24: [34, 94, 168], 48: [12, 44, 132] } as Record<number, RGB>,
};
export function horizonRGB(h: number): RGB {
  return MAP.horizon[h] ?? [37, 52, 148];
}
