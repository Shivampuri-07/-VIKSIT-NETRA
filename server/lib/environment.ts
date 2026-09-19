/**
 * Environmental forcing (wind + surface current) with explicit provenance.
 *
 * Every sample returned by this module carries a status so that nothing
 * derived from a fallback can be presented as an observation:
 *
 *   REAL           inside the time range and spatial grid of a real product
 *   PERSISTED      real product, but the requested time is outside its time
 *                  range, so the nearest available field is held constant
 *   EDGE_CLAMPED   real product, but the position is outside the grid, so the
 *                  nearest grid edge is used
 *   DEMO_CONSTANT  synthetic scene constant (demo scenes only)
 *   USER_OVERRIDE  value supplied by the analyst through the API
 *   NOT_AVAILABLE  no product: the component is treated as zero and flagged
 *
 * Units: u (eastward) and v (northward) in m/s.
 */

import fs from "fs";
import path from "path";
import { vectorBearingTo, windDirectionFrom } from "./geo";

export type SampleStatus =
  | "REAL"
  | "PERSISTED"
  | "EDGE_CLAMPED"
  | "PERSISTED+EDGE_CLAMPED"
  | "DEMO_CONSTANT"
  | "USER_OVERRIDE"
  | "LAND_OR_NO_DATA"
  | "NOT_AVAILABLE";

export interface GriddedField {
  schema: string;
  kind: string;
  source: string;
  source_file?: string;
  units: string;
  times: string[];
  lats: number[];
  lons: number[];
  /** [time][lat][lon]; null = land / no data (never filled: samples touching it are LAND_OR_NO_DATA) */
  u: (number | null)[][][];
  v: (number | null)[][][];
  provenance?: Record<string, unknown>;
}

export type FieldSource =
  | { kind: "gridded"; field: GriddedField; label: string; timesMs: number[] }
  | { kind: "constant"; u: number; v: number; status: "DEMO_CONSTANT" | "USER_OVERRIDE"; label: string }
  | { kind: "none"; label: string };

export interface VectorSample {
  u: number;
  v: number;
  status: SampleStatus;
}

export interface EnvironmentModel {
  wind: FieldSource;
  current: FieldSource;
}

// ---------------------------------------------------------------------------
// loading
// ---------------------------------------------------------------------------

export function loadGriddedField(filePath: string, label: string): FieldSource {
  try {
    if (!fs.existsSync(filePath)) {
      return { kind: "none", label: `${label}: file not found (${path.basename(filePath)})` };
    }
    const field = JSON.parse(fs.readFileSync(filePath, "utf8")) as GriddedField;
    validateField(field);
    return {
      kind: "gridded",
      field,
      label,
      timesMs: field.times.map((t) => Date.parse(t)),
    };
  } catch (error) {
    return { kind: "none", label: `${label}: unreadable (${(error as Error).message})` };
  }
}

export function validateField(field: GriddedField): void {
  const nt = field.times.length;
  const ny = field.lats.length;
  const nx = field.lons.length;
  if (!nt || !ny || !nx) throw new Error("empty field axes");
  for (const comp of [field.u, field.v]) {
    if (comp.length !== nt) throw new Error("time dimension mismatch");
    for (const slab of comp) {
      if (slab.length !== ny) throw new Error("lat dimension mismatch");
      for (const row of slab) {
        if (row.length !== nx) throw new Error("lon dimension mismatch");
        for (const x of row) if (x !== null && !Number.isFinite(x)) throw new Error("non-finite value in field (use null for land / no data)");
      }
    }
  }
  for (const t of field.times) if (!Number.isFinite(Date.parse(t))) throw new Error(`bad time ${t}`);
}

// ---------------------------------------------------------------------------
// interpolation
// ---------------------------------------------------------------------------

/** Bracketing index + weight along a monotonic (increasing OR decreasing) axis. */
function bracket(axis: number[], x: number): { i0: number; i1: number; w: number; clamped: boolean } {
  const n = axis.length;
  if (n === 1) return { i0: 0, i1: 0, w: 0, clamped: x !== axis[0] };
  const increasing = axis[n - 1] > axis[0];
  const lo = increasing ? axis[0] : axis[n - 1];
  const hi = increasing ? axis[n - 1] : axis[0];
  if (x < lo || x > hi) {
    const atStart = increasing ? x < lo : x > hi;
    const idx = atStart ? 0 : n - 1;
    return { i0: idx, i1: idx, w: 0, clamped: true };
  }
  for (let i = 0; i < n - 1; i++) {
    const a = axis[i];
    const b = axis[i + 1];
    if ((x >= Math.min(a, b) && x <= Math.max(a, b))) {
      const w = b === a ? 0 : (x - a) / (b - a);
      return { i0: i, i1: i + 1, w, clamped: false };
    }
  }
  return { i0: n - 1, i1: n - 1, w: 0, clamped: true };
}

function bilinear(slab: (number | null)[][], by: ReturnType<typeof bracket>, bx: ReturnType<typeof bracket>): number {
  const q00 = slab[by.i0][bx.i0];
  const q01 = slab[by.i0][bx.i1];
  const q10 = slab[by.i1][bx.i0];
  const q11 = slab[by.i1][bx.i1];
  // a null corner (land / no data) makes the sample undefined: it is NOT filled from its neighbours
  if (q00 === null || q01 === null || q10 === null || q11 === null) return NaN;
  const top = q00 * (1 - bx.w) + q01 * bx.w;
  const bottom = q10 * (1 - bx.w) + q11 * bx.w;
  return top * (1 - by.w) + bottom * by.w;
}

/** Sample a forcing source at (lat, lon, time). */
export function sampleField(source: FieldSource, lat: number, lon: number, tMs: number): VectorSample {
  if (source.kind === "none") return { u: 0, v: 0, status: "NOT_AVAILABLE" };
  if (source.kind === "constant") return { u: source.u, v: source.v, status: source.status };

  const f = source.field;
  const by = bracket(f.lats, lat);
  const bx = bracket(f.lons, lon);
  const bt = bracket(source.timesMs, tMs);

  const u0 = bilinear(f.u[bt.i0], by, bx);
  const v0 = bilinear(f.v[bt.i0], by, bx);
  const u1 = bilinear(f.u[bt.i1], by, bx);
  const v1 = bilinear(f.v[bt.i1], by, bx);

  const u = u0 * (1 - bt.w) + u1 * bt.w;
  const v = v0 * (1 - bt.w) + v1 * bt.w;
  if (!Number.isFinite(u) || !Number.isFinite(v)) return { u: 0, v: 0, status: "LAND_OR_NO_DATA" };

  const spaceClamped = by.clamped || bx.clamped;
  let status: SampleStatus = "REAL";
  if (bt.clamped && spaceClamped) status = "PERSISTED+EDGE_CLAMPED";
  else if (bt.clamped) status = "PERSISTED";
  else if (spaceClamped) status = "EDGE_CLAMPED";
  return { u, v, status };
}

/** All grid vectors at a given time (for map display). */
export function gridVectors(source: FieldSource, tMs: number): {
  lat: number; lon: number; u: number; v: number; speed_ms: number; direction_to_deg: number; direction_from_deg: number; status: SampleStatus;
}[] {
  if (source.kind !== "gridded") return [];
  const f = source.field;
  const bt = bracket(source.timesMs, tMs);
  const out = [];
  for (let iy = 0; iy < f.lats.length; iy++) {
    for (let ix = 0; ix < f.lons.length; ix++) {
      const a0 = f.u[bt.i0][iy][ix], a1 = f.u[bt.i1][iy][ix], b0 = f.v[bt.i0][iy][ix], b1 = f.v[bt.i1][iy][ix];
      if (a0 === null || a1 === null || b0 === null || b1 === null) continue;   // land / no data: not drawn, not filled
      const u = a0 * (1 - bt.w) + a1 * bt.w;
      const v = b0 * (1 - bt.w) + b1 * bt.w;
      out.push({
        lat: f.lats[iy],
        lon: f.lons[ix],
        u,
        v,
        speed_ms: Math.hypot(u, v),
        direction_to_deg: vectorBearingTo(u, v),
        direction_from_deg: windDirectionFrom(u, v),
        status: (bt.clamped ? "PERSISTED" : "REAL") as SampleStatus,
      });
    }
  }
  return out;
}

/** Time series of the field at one point, at the product's native times. */
export function nativeTimeSeries(source: FieldSource, lat: number, lon: number) {
  if (source.kind !== "gridded") return [];
  return source.timesMs.map((t, i) => {
    const s = sampleField(source, lat, lon, t);
    return {
      time: source.field.times[i],
      u: s.u,
      v: s.v,
      speed_ms: Math.hypot(s.u, s.v),
      direction_to_deg: vectorBearingTo(s.u, s.v),
      direction_from_deg: windDirectionFrom(s.u, s.v),
      status: s.status,
    };
  });
}

export function describeSource(source: FieldSource) {
  if (source.kind === "none") {
    return { available: false, kind: "none", status: "NOT_AVAILABLE" as SampleStatus, label: source.label };
  }
  if (source.kind === "constant") {
    return { available: true, kind: "constant", status: source.status, label: source.label, u: source.u, v: source.v };
  }
  const f = source.field;
  return {
    available: true,
    kind: "gridded",
    status: "REAL" as SampleStatus,
    label: source.label,
    source: f.source,
    source_file: f.source_file,
    time_range: [f.times[0], f.times[f.times.length - 1]],
    n_times: f.times.length,
    lat_range: [Math.min(...f.lats), Math.max(...f.lats)],
    lon_range: [Math.min(...f.lons), Math.max(...f.lons)],
    grid_shape: [f.times.length, f.lats.length, f.lons.length],
    provenance: f.provenance ?? null,
  };
}
