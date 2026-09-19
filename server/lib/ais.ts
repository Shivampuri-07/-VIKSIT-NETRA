/**
 * AIS ingestion and track reconstruction.
 *
 * MarineCadastre CSV timestamps ("2018-09-26 17:21:38") carry no zone suffix;
 * MarineCadastre publishes UTC, so they are parsed explicitly as UTC here.
 * AIS "not available" sentinels are removed: SOG 102.3 kn, COG 360 deg,
 * heading 511.
 */

import { haversineKm } from "./geo";

export interface AisPoint {
  mmsi: string;
  t: number;
  lat: number;
  lon: number;
  sog: number | null;
  cog: number | null;
  heading: number | null;
  vessel_name: string | null;
  imo: string | null;
  call_sign: string | null;
  vessel_type_code: number | null;
  vessel_type_label: string;
  length_m: number | null;
  width_m: number | null;
  flag: string | null;
  synthetic: boolean;
}

export interface VesselTrack {
  mmsi: string;
  points: AisPoint[];
  meta: {
    vessel_name: string | null;
    imo: string | null;
    call_sign: string | null;
    vessel_type_code: number | null;
    vessel_type_label: string;
    length_m: number | null;
    width_m: number | null;
    flag: string | null;
    synthetic: boolean;
  };
}

/** ITU-R M.1371 ship-type code families. */
export function aisTypeLabel(code: number | null): string {
  if (code === null || !Number.isFinite(code)) return "Not reported";
  const c = Math.round(code);
  if (c === 30) return "Fishing";
  if (c === 31 || c === 32) return "Towing";
  if (c === 33) return "Dredging / underwater ops";
  if (c === 34) return "Diving ops";
  if (c === 35) return "Military ops";
  if (c === 36) return "Sailing";
  if (c === 37) return "Pleasure craft";
  if (c >= 40 && c <= 49) return "High-speed craft";
  if (c === 50) return "Pilot vessel";
  if (c === 51) return "Search and rescue";
  if (c === 52) return "Tug";
  if (c === 53) return "Port tender";
  if (c === 54) return "Anti-pollution equipment";
  if (c === 55) return "Law enforcement";
  if (c === 58) return "Medical transport";
  if (c >= 60 && c <= 69) return "Passenger";
  if (c >= 70 && c <= 79) return "Cargo";
  if (c >= 80 && c <= 89) return "Tanker";
  if (c >= 90 && c <= 99) return "Other type";
  return `Code ${c}`;
}

function num(x: string | undefined | null): number | null {
  if (x === undefined || x === null) return null;
  const s = String(x).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function str(x: string | undefined | null): string | null {
  if (x === undefined || x === null) return null;
  const s = String(x).trim();
  return s ? s : null;
}

export function parseUtc(ts: string): number {
  let s = String(ts).trim().replace(" ", "T");
  if (!/[zZ]$|[+-]\d\d:?\d\d$/.test(s)) s += "Z";
  return Date.parse(s);
}

function cleanSog(x: number | null): number | null {
  return x === null || x < 0 || x >= 102.2 ? null : x;
}
function cleanCog(x: number | null): number | null {
  return x === null || x < 0 || x >= 360 ? null : x;
}
function cleanHeading(x: number | null): number | null {
  return x === null || x < 0 || x >= 360 ? null : x;
}

/** Minimal RFC-4180-ish CSV splitter (handles quoted fields). */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

export function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0]).map((h) => h.trim());
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = splitCsvLine(lines[i]);
    const row: Record<string, string> = {};
    header.forEach((h, j) => (row[h] = (vals[j] ?? "").trim()));
    rows.push(row);
  }
  return rows;
}

export function parseMarineCadastreCsv(text: string): AisPoint[] {
  const out: AisPoint[] = [];
  for (const r of parseCsv(text)) {
    const lat = num(r.latitude ?? r.LAT);
    const lon = num(r.longitude ?? r.LON);
    const t = parseUtc(r.base_date_time ?? r.BaseDateTime ?? "");
    const mmsi = str(r.mmsi ?? r.MMSI);
    if (lat === null || lon === null || !mmsi || !Number.isFinite(t)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const code = num(r.vessel_type ?? r.VesselType);
    out.push({
      mmsi,
      t,
      lat,
      lon,
      sog: cleanSog(num(r.sog ?? r.SOG)),
      cog: cleanCog(num(r.cog ?? r.COG)),
      heading: cleanHeading(num(r.heading ?? r.Heading)),
      vessel_name: str(r.vessel_name ?? r.VesselName),
      imo: str(r.imo ?? r.IMO),
      call_sign: str(r.call_sign ?? r.CallSign),
      vessel_type_code: code,
      vessel_type_label: aisTypeLabel(code),
      length_m: num(r.length ?? r.Length),
      width_m: num(r.width ?? r.Width),
      flag: null,
      synthetic: false,
    });
  }
  return out;
}

/** Demo JSON produced by scripts/generate_sample_data.py (SYNTHETIC). */
export function parseDemoAisJson(rows: any[]): AisPoint[] {
  const out: AisPoint[] = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const lat = Number(r.latitude);
    const lon = Number(r.longitude);
    const t = parseUtc(String(r.timestamp ?? ""));
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(t) || !r.mmsi) continue;
    out.push({
      mmsi: String(r.mmsi),
      t,
      lat,
      lon,
      sog: cleanSog(Number.isFinite(Number(r.sog)) ? Number(r.sog) : null),
      cog: cleanCog(Number.isFinite(Number(r.cog)) ? Number(r.cog) : null),
      heading: null,
      vessel_name: r.vessel_name ? `${r.vessel_name} [SYNTHETIC]` : "[SYNTHETIC]",
      imo: null, // synthetic IMO numbers are deliberately not propagated
      call_sign: null,
      vessel_type_code: null,
      vessel_type_label: r.vessel_type ? `${r.vessel_type} (synthetic)` : "Not reported",
      length_m: Number.isFinite(Number(r.length)) ? Number(r.length) : null,
      width_m: null,
      flag: r.flag ?? null,
      synthetic: true,
    });
  }
  return out;
}

function mode<T>(xs: (T | null)[]): T | null {
  const counts = new Map<T, number>();
  for (const x of xs) if (x !== null && x !== undefined) counts.set(x, (counts.get(x) ?? 0) + 1);
  let best: T | null = null;
  let bestN = 0;
  for (const [k, n] of counts) if (n > bestN) { best = k; bestN = n; }
  return best;
}

export function groupTracks(points: AisPoint[]): VesselTrack[] {
  const groups = new Map<string, AisPoint[]>();
  for (const p of points) {
    if (!groups.has(p.mmsi)) groups.set(p.mmsi, []);
    groups.get(p.mmsi)!.push(p);
  }
  const tracks: VesselTrack[] = [];
  for (const [mmsi, pts] of groups) {
    pts.sort((a, b) => a.t - b.t);
    const dedup: AisPoint[] = [];
    for (const p of pts) if (!dedup.length || dedup[dedup.length - 1].t !== p.t) dedup.push(p);
    const code = mode(dedup.map((p) => p.vessel_type_code));
    tracks.push({
      mmsi,
      points: dedup,
      meta: {
        vessel_name: mode(dedup.map((p) => p.vessel_name)),
        imo: mode(dedup.map((p) => p.imo)),
        call_sign: mode(dedup.map((p) => p.call_sign)),
        vessel_type_code: code,
        vessel_type_label: code !== null ? aisTypeLabel(code) : mode(dedup.map((p) => p.vessel_type_label)) ?? "Not reported",
        length_m: mode(dedup.map((p) => (p.length_m && p.length_m > 0 ? p.length_m : null))),
        width_m: mode(dedup.map((p) => (p.width_m && p.width_m > 0 ? p.width_m : null))),
        flag: mode(dedup.map((p) => p.flag)),
        synthetic: dedup.some((p) => p.synthetic),
      },
    });
  }
  return tracks;
}

/**
 * Vessel position at time t by linear interpolation between the bracketing
 * AIS reports. Returns null outside the track or across gaps > maxGapMs
 * (no extrapolation, no bridging of long gaps).
 */
export function positionAt(track: VesselTrack, tMs: number, maxGapMs = 30 * 60 * 1000): { lat: number; lon: number } | null {
  const pts = track.points;
  if (!pts.length || tMs < pts[0].t || tMs > pts[pts.length - 1].t) return null;
  let lo = 0;
  let hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].t <= tMs) lo = mid;
    else hi = mid;
  }
  const a = pts[lo];
  const b = pts[hi];
  if (a.t === tMs) return { lat: a.lat, lon: a.lon };
  if (b.t === tMs) return { lat: b.lat, lon: b.lon };
  if (b.t - a.t > maxGapMs) return null;
  const w = (tMs - a.t) / (b.t - a.t);
  return { lat: a.lat + (b.lat - a.lat) * w, lon: a.lon + (b.lon - a.lon) * w };
}

export interface AisQuality {
  n_points: number;
  n_points_in_window: number;
  first_report: string;
  last_report: string;
  median_interval_min: number | null;
  max_gap_in_window_min: number | null;
  window_coverage_fraction: number;
  implied_speed_outliers: number;
  quality_label: "GOOD" | "FAIR" | "POOR";
}

export function trackQuality(track: VesselTrack, windowStartMs: number, windowEndMs: number): AisQuality {
  const pts = track.points;
  const intervals: number[] = [];
  let outliers = 0;
  for (let i = 1; i < pts.length; i++) {
    const dtMin = (pts[i].t - pts[i - 1].t) / 60000;
    intervals.push(dtMin);
    const km = haversineKm(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
    const kn = dtMin > 0 ? (km / 1.852) / (dtMin / 60) : 0;
    if (kn > 50 && km > 1) outliers++;
  }
  intervals.sort((a, b) => a - b);
  const inWin = pts.filter((p) => p.t >= windowStartMs && p.t <= windowEndMs);
  // gaps inside the window, including window edges
  const stamps = [windowStartMs, ...inWin.map((p) => p.t), windowEndMs];
  let maxGap = 0;
  for (let i = 1; i < stamps.length; i++) maxGap = Math.max(maxGap, (stamps[i] - stamps[i - 1]) / 60000);
  // coverage: fraction of 10-minute slots in window that have a position (interpolable)
  const slots = Math.max(1, Math.round((windowEndMs - windowStartMs) / 600000));
  let covered = 0;
  for (let s = 0; s <= slots; s++) {
    if (positionAt(track, windowStartMs + s * 600000)) covered++;
  }
  const coverage = covered / (slots + 1);
  const quality: AisQuality["quality_label"] = coverage >= 0.6 && outliers === 0 ? "GOOD" : coverage >= 0.2 ? "FAIR" : "POOR";
  return {
    n_points: pts.length,
    n_points_in_window: inWin.length,
    first_report: new Date(pts[0].t).toISOString(),
    last_report: new Date(pts[pts.length - 1].t).toISOString(),
    median_interval_min: intervals.length ? Math.round(intervals[Math.floor(intervals.length / 2)] * 100) / 100 : null,
    max_gap_in_window_min: Math.round(maxGap * 10) / 10,
    window_coverage_fraction: Math.round(coverage * 1000) / 1000,
    implied_speed_outliers: outliers,
    quality_label: quality,
  };
}
