/**
 * AEGIS geodesy / geometry / statistics utilities.
 *
 * Conventions used everywhere in the engine:
 *   - Coordinates in GeoJSON order [lon, lat] unless a name says LatLon.
 *   - u = eastward component, v = northward component (m/s).
 *   - Bearings are COMPASS bearings: 0 = north, 90 = east, clockwise.
 *   - Earth radius R = 6 371 008.8 m (mean radius, consistent with haversine).
 */

export const EARTH_RADIUS_M = 6371008.8;
export const DEG = Math.PI / 180;

export type LonLat = [number, number];
export type LatLon = [number, number];

/** Metres per degree of latitude (spherical Earth). */
export const M_PER_DEG_LAT = EARTH_RADIUS_M * DEG;

/** Metres per degree of longitude at a given latitude. */
export function mPerDegLon(latDeg: number): number {
  return M_PER_DEG_LAT * Math.max(1e-6, Math.cos(latDeg * DEG));
}

/** Great-circle distance in kilometres. */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return (EARTH_RADIUS_M / 1000) * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - Math.min(1, a)));
}

/** Initial compass bearing (deg, clockwise from north) from point 1 to point 2. */
export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = lat1 * DEG;
  const p2 = lat2 * DEG;
  const dl = (lon2 - lon1) * DEG;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) / DEG + 360) % 360;
}

/**
 * Compass bearing the vector (u east, v north) points TOWARD.
 * NOTE: atan2(u, v) — not atan2(v, u), which would be a mathematical angle
 * measured counter-clockwise from east.
 */
export function vectorBearingTo(u: number, v: number): number {
  return (Math.atan2(u, v) / DEG + 360) % 360;
}

/** Meteorological convention: direction the wind blows FROM. */
export function windDirectionFrom(u: number, v: number): number {
  return (vectorBearingTo(u, v) + 180) % 360;
}

/** Smallest difference between two directions (0..180). */
export function angularDifference(a: number, b: number): number {
  let d = Math.abs(a - b) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

/**
 * Difference between two AXES (undirected lines), 0..90.
 * A slick orientation of 233.7 deg and 53.7 deg describe the same axis.
 */
export function axialDifference(a: number, b: number): number {
  const d = Math.abs(a - b) % 180;
  return Math.min(d, 180 - d);
}

/** Displace a point by metres east (dx) and north (dy). */
export function offsetMeters(lat: number, lon: number, dxM: number, dyM: number): LatLon {
  return [lat + dyM / M_PER_DEG_LAT, lon + dxM / mPerDegLon(lat)];
}

/** Local tangent-plane projection (metres) around a reference point. */
export function toLocalXY(lat: number, lon: number, lat0: number, lon0: number): [number, number] {
  return [(lon - lon0) * mPerDegLon(lat0), (lat - lat0) * M_PER_DEG_LAT];
}

export function fromLocalXY(x: number, y: number, lat0: number, lon0: number): LatLon {
  return [lat0 + y / M_PER_DEG_LAT, lon0 + x / mPerDegLon(lat0)];
}

/** Planar polygon area (m^2) of a ring given in local XY metres (shoelace). */
export function shoelaceArea(xy: [number, number][]): number {
  let s = 0;
  for (let i = 0; i < xy.length; i++) {
    const [x1, y1] = xy[i];
    const [x2, y2] = xy[(i + 1) % xy.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

/**
 * Area of a [lon,lat] ring in km^2 using a local equal-distance projection.
 * Accurate to well under 1 % for rings a few hundred km across.
 */
export function ringAreaKm2(ring: LonLat[]): number {
  if (ring.length < 3) return 0;
  const lat0 = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const lon0 = ring.reduce((s, p) => s + p[0], 0) / ring.length;
  const xy = ring.map(([lon, lat]) => toLocalXY(lat, lon, lat0, lon0));
  return shoelaceArea(xy) / 1e6;
}

export function ringPerimeterKm(ring: LonLat[]): number {
  let p = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    p += haversineKm(ring[i][1], ring[i][0], ring[i + 1][1], ring[i + 1][0]);
  }
  return p;
}

/** Ray-casting point-in-polygon for a [lon,lat] ring. */
export function pointInRing(lon: number, lat: number, ring: LonLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-300) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Distance (km) from a point to a ring boundary; 0 if the point is inside. */
export function distanceToRingKm(lat: number, lon: number, ring: LonLat[]): number {
  if (ring.length >= 3 && pointInRing(lon, lat, ring)) return 0;
  let best = Infinity;
  for (let i = 0; i < ring.length - 1; i++) {
    const [ax, ay] = toLocalXY(ring[i][1], ring[i][0], lat, lon);
    const [bx, by] = toLocalXY(ring[i + 1][1], ring[i + 1][0], lat, lon);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = ax + t * dx;
    const py = ay + t * dy;
    best = Math.min(best, Math.sqrt(px * px + py * py) / 1000);
  }
  return best;
}

/** Andrew's monotone-chain convex hull on [lon,lat] points; returns a closed ring. */
export function convexHull(points: LonLat[]): LonLat[] {
  const pts = points
    .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .slice()
    .sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));
  if (pts.length < 3) return pts.length ? [...pts, pts[0]] : [];
  const cross = (o: LonLat, a: LonLat, b: LonLat) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: LonLat[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: LonLat[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  const hull = lower.concat(upper);
  return [...hull, hull[0]];
}

/** Circle ring (closed) of a given radius in km. */
export function circleRing(lat: number, lon: number, radiusKm: number, n = 48): LonLat[] {
  const ring: LonLat[] = [];
  for (let i = 0; i < n; i++) {
    const th = (2 * Math.PI * i) / n;
    const [la, lo] = offsetMeters(lat, lon, radiusKm * 1000 * Math.cos(th), radiusKm * 1000 * Math.sin(th));
    ring.push([round(lo, 6), round(la, 6)]);
  }
  ring.push(ring[0]);
  return ring;
}

/**
 * Principal axis (compass bearing of the major axis, 0..180) and elongation
 * of a polygon ring, from second moments of area.
 */
export function ringPrincipalAxis(ring: LonLat[]): { axis_deg: number; elongation: number } {
  const lat0 = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const lon0 = ring.reduce((s, p) => s + p[0], 0) / ring.length;
  const xy = ring.slice(0, -1).map(([lo, la]) => toLocalXY(la, lo, lat0, lon0));
  let A = 0, cx = 0, cy = 0;
  for (let i = 0; i < xy.length; i++) {
    const [x1, y1] = xy[i];
    const [x2, y2] = xy[(i + 1) % xy.length];
    const c = x1 * y2 - x2 * y1;
    A += c / 2; cx += ((x1 + x2) * c) / 6; cy += ((y1 + y2) * c) / 6;
  }
  if (Math.abs(A) < 1e-9) return { axis_deg: 0, elongation: 1 };
  cx /= A; cy /= A;
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < xy.length; i++) {
    const x1 = xy[i][0] - cx, y1 = xy[i][1] - cy;
    const x2 = xy[(i + 1) % xy.length][0] - cx, y2 = xy[(i + 1) % xy.length][1] - cy;
    const c = x1 * y2 - x2 * y1;
    sxx += ((x1 * x1 + x1 * x2 + x2 * x2) * c) / 12;
    syy += ((y1 * y1 + y1 * y2 + y2 * y2) * c) / 12;
    sxy += ((x1 * y2 + 2 * x1 * y1 + 2 * x2 * y2 + x2 * y1) * c) / 24;
  }
  if (A < 0) { sxx = -sxx; syy = -syy; sxy = -sxy; }
  const tr = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + disc;
  const l2 = Math.max(1e-12, tr / 2 - disc);
  // eigenvector of the larger eigenvalue
  let ex = sxy, ey = l1 - sxx;
  if (Math.abs(ex) < 1e-12 && Math.abs(ey) < 1e-12) { ex = sxx >= syy ? 1 : 0; ey = sxx >= syy ? 0 : 1; }
  const axis = ((Math.atan2(ex, ey) / DEG) % 180 + 180) % 180;
  return { axis_deg: axis, elongation: Math.sqrt(l1 / l2) };
}

// ---------------------------------------------------------------------------
// statistics
// ---------------------------------------------------------------------------

export function percentile(sortedAsc: number[], p: number): number {
  if (!sortedAsc.length) return NaN;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, (sortedAsc.length - 1) * p));
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN;
}

export function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

export function round(x: number, digits = 3): number {
  if (!Number.isFinite(x)) return x;
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

// ---------------------------------------------------------------------------
// reproducible random numbers
// ---------------------------------------------------------------------------

/** mulberry32 PRNG — small, fast, reproducible for a given seed. */
export function createRng(seed: number): { uniform: () => number; gauss: () => number } {
  let a = seed >>> 0;
  const uniform = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let spare: number | null = null;
  const gauss = () => {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    let u = 0, v = 0, s = 0;
    do {
      u = uniform() * 2 - 1;
      v = uniform() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const m = Math.sqrt((-2 * Math.log(s)) / s);
    spare = v * m;
    return u * m;
  };
  return { uniform, gauss };
}

export function formatLat(lat: number, digits = 4): string {
  return `${Math.abs(lat).toFixed(digits)}°${lat >= 0 ? "N" : "S"}`;
}

export function formatLon(lon: number, digits = 4): string {
  return `${Math.abs(lon).toFixed(digits)}°${lon >= 0 ? "E" : "W"}`;
}
