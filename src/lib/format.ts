export function fmtLat(lat: number | null | undefined, digits = 4): string {
  if (lat === null || lat === undefined || !Number.isFinite(lat)) return "n/a";
  return `${Math.abs(lat).toFixed(digits)}°${lat >= 0 ? "N" : "S"}`;
}

export function fmtLon(lon: number | null | undefined, digits = 4): string {
  if (lon === null || lon === undefined || !Number.isFinite(lon)) return "n/a";
  return `${Math.abs(lon).toFixed(digits)}°${lon >= 0 ? "E" : "W"}`;
}

export function fmtLatLon(p: [number, number] | number[] | null | undefined, digits = 4): string {
  if (!p || p.length < 2) return "n/a";
  return `${fmtLat(p[0], digits)}, ${fmtLon(p[1], digits)}`;
}

export function fmt(x: number | null | undefined, digits = 2, unit = ""): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "n/a";
  return `${x.toFixed(digits)}${unit ? " " + unit : ""}`;
}

export function utc(iso: string | null | undefined): string {
  if (!iso) return "n/a";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "n/a" : d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

/** Colour for data-provenance badges (light institutional theme). UI only - the PDF report has its own palette. */
export function statusColor(status: string | undefined | null): string {
  const s = String(status ?? "");
  if (s === "REAL" || s === "REAL_DERIVED") return "#16803a";
  if (s === "MODEL_PREDICTION") return "#3e54a0";
  if (s === "DERIVED_GEOMETRY") return "#6b7fc7";
  if (s === "LAND_OR_NO_DATA") return "#667085";
  if (s.includes("PERSISTED") || s.includes("EDGE") || s === "REFERENCE_LABEL") return "#b7791f";
  if (s.includes("DEMO") || s.includes("SYNTHETIC")) return "#7c3aed";
  if (s === "NOT_AVAILABLE") return "#667085";
  return "#667085";
}

/** Plain-language name for a provenance status (colour is never the only carrier of meaning). */
export function statusLabel(status: string | undefined | null): string {
  switch (String(status ?? "")) {
    case "REAL": return "Real";
    case "REAL_DERIVED": return "Real (derived)";
    case "MODEL_PREDICTION": return "Model prediction";
    case "DERIVED_GEOMETRY": return "Derived geometry";
    case "REFERENCE_LABEL": return "Reference label";
    case "PERSISTED": return "Persisted";
    case "EDGE_CLAMPED": return "Edge-clamped";
    case "PERSISTED+EDGE_CLAMPED": return "Persisted + edge-clamped";
    case "LAND_OR_NO_DATA": return "Land / no data";
    case "DEMO_CONSTANT": return "Demo constant";
    case "SYNTHETIC_DEMO": return "Synthetic demo";
    case "USER_OVERRIDE": return "User override";
    case "NOT_AVAILABLE": return "Not available";
    case "": return "Unknown";
    default: return String(status).replace(/_/g, " ").toLowerCase();
  }
}

export function levelColor(level: string | undefined | null): string {
  switch (level) {
    case "LOW": return "#16803a";
    case "MEDIUM": case "MODERATE": return "#b7791f";
    case "HIGH": return "#c2410c";
    case "SEVERE": return "#c53030";
    case "STRONG": return "#16803a";
    case "WEAK": return "#667085";
    default: return "#667085";
  }
}

/** Sequential teal -> navy ramp for forecast horizons: later horizons must not read as "more severe". */
export const HORIZON_COLORS: Record<number, string> = { 6: "#41b6c4", 12: "#1d91c0", 24: "#225ea8", 48: "#0c2c84" };
export function horizonColor(h: number): string {
  return HORIZON_COLORS[h] ?? "#253494";
}
