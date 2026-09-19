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

/** Colour for data-provenance badges. */
export function statusColor(status: string | undefined | null): string {
  const s = String(status ?? "");
  if (s === "REAL" || s === "REAL_DERIVED") return "#3fb950";
  if (s === "MODEL_PREDICTION") return "#8b9cff";
  if (s === "DERIVED_GEOMETRY") return "#b4c0ff";
  if (s === "LAND_OR_NO_DATA") return "#8b949e";
  if (s.includes("PERSISTED") || s.includes("EDGE") || s === "REFERENCE_LABEL") return "#d29922";
  if (s.includes("DEMO") || s.includes("SYNTHETIC")) return "#bc8cff";
  if (s === "NOT_AVAILABLE") return "#f85149";
  return "#8b949e";
}

export function levelColor(level: string | undefined | null): string {
  switch (level) {
    case "LOW": return "#3fb950";
    case "MEDIUM": case "MODERATE": return "#d29922";
    case "HIGH": return "#f0883e";
    case "SEVERE": return "#f85149";
    case "STRONG": return "#3fb950";
    case "WEAK": return "#8b949e";
    default: return "#8b949e";
  }
}

export const HORIZON_COLORS: Record<number, string> = { 6: "#3fb950", 12: "#d29922", 24: "#f0883e", 48: "#f85149" };
export function horizonColor(h: number): string {
  return HORIZON_COLORS[h] ?? "#bc8cff";
}
