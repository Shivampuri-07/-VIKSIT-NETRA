/**
 * AEGIS Lagrangian particle drift engine.
 *
 * dx/dt = U_current(x, t) + U_prior + alpha * R(theta) * U_wind10(x, t)  +  diffusion
 *
 *   alpha      wind drift (leeway) factor, default 0.03
 *   R(theta)   rotation of the wind vector by the deflection angle, CLOCKWISE
 *              (to the right) in the northern hemisphere, counter-clockwise in
 *              the southern hemisphere
 *   diffusion  isotropic random walk, per-axis std = sqrt(2 K dt)
 *   U_prior    per-particle constant drawn from N(0, sigma^2) per component,
 *              used ONLY when no current product is available. It is a
 *              zero-mean uncertainty prior, not an observed current.
 *
 * Integration: 2nd-order Runge-Kutta (midpoint) with time-varying forcing.
 * BACKWARD mode integrates with dt < 0 (time runs backwards from the
 * observation); the random walk is applied in both directions.
 *
 * What this model does NOT include (and therefore must not be claimed):
 * weathering (evaporation, emulsification, dispersion into the water column),
 * beaching, Stokes drift from waves, or vertical processes. Areas reported
 * are TRANSPORT envelopes of surface particles, not oil-thickness footprints.
 */

import {
  LonLat,
  LatLon,
  DEG,
  M_PER_DEG_LAT,
  mPerDegLon,
  createRng,
  pointInRing,
  convexHull,
  ringAreaKm2,
  haversineKm,
  bearingDeg,
  percentile,
  mean,
  round,
} from "./geo";
import { EnvironmentModel, sampleField, SampleStatus } from "./environment";

export type DriftMode = "BACKWARD" | "FORWARD";

export interface DriftParams {
  mode: DriftMode;
  hours: number;
  timestepMinutes: number;
  numParticles: number;
  windFactor: number;
  deflectionDeg: number;
  eddyDiffusivity: number;
  unknownCurrentSigma: number;
  /** Multiplier on the current product (default 1). Values != 1 are WHAT-IF sensitivity cases, never data. */
  currentScale: number;
  seed: number;
  snapshotHours: number[];
  storedTracks: number;
  maxSnapshotParticles: number;
}

export const DEFAULT_DRIFT_PARAMS: DriftParams = {
  mode: "BACKWARD",
  hours: 12,
  timestepMinutes: 30,
  numParticles: 300,
  windFactor: 0.03,
  deflectionDeg: 5,
  eddyDiffusivity: 2.5,
  unknownCurrentSigma: 0.1,
  currentScale: 1,
  seed: 42,
  snapshotHours: [],
  storedTracks: 40,
  maxSnapshotParticles: 400,
};

export interface DriftInput {
  startTimeIso: string;
  seedRing: LonLat[] | null;
  /** Optional: every polygon of a multi-part slick. Particles are seeded uniformly over the union. */
  seedRings?: LonLat[][] | null;
  seedPoint: LatLon;
  env: EnvironmentModel;
}

export interface DriftSnapshot {
  hours: number;
  signed_hours: number;
  time: string;
  centroid: LatLon;
  r50_km: number;
  r90_km: number;
  hull: LonLat[];
  hull_area_km2: number;
  particles: LonLat[];
  displacement_km: number;
  displacement_bearing_deg: number;
  mean_drift_speed_ms: number;
  wind_real_fraction: number;
  current_real_fraction: number;
  /**
   * Whether the forcing behind this horizon is supported by real product coverage. A horizon is `supported` only when
   * BOTH wind and current samples so far are >= 50 % REAL (not PERSISTED / EDGE_CLAMPED / prior). null = synthetic demo forcing.
   */
  forcing_support: { supported: boolean | null; wind_real_fraction: number; current_real_fraction: number; reason: string };
}

export interface CentroidPathPoint {
  signed_hours: number;
  time: string;
  lat: number;
  lon: number;
  r50_km: number;
  r90_km: number;
}

export interface DriftResult {
  mode: DriftMode;
  start_time: string;
  end_time: string;
  hours: number;
  timestep_minutes: number;
  num_particles: number;
  seed: number;
  start_centroid: LatLon;
  final: DriftSnapshot;
  snapshots: DriftSnapshot[];
  centroid_path: CentroidPathPoint[];
  tracks: LonLat[][];
  forcing: {
    wind_factor: number;
    deflection_deg: number;
    deflection_sense: string;
    eddy_diffusivity_m2s: number;
    unknown_current_prior_sigma_ms: number;
    current_prior_applied: boolean;
    current_scale: number;
    wind_status_fractions: Record<string, number>;
    current_status_fractions: Record<string, number>;
    integration: string;
  };
  warnings: string[];
  model_limitations: string[];
}

const MIN_DT_S = 60;

function rotateWind(u: number, v: number, deflectionDeg: number, lat: number): [number, number] {
  // clockwise (to the right) in NH, counter-clockwise in SH
  const th = (lat >= 0 ? 1 : -1) * deflectionDeg * DEG;
  const c = Math.cos(th);
  const s = Math.sin(th);
  return [u * c + v * s, -u * s + v * c];
}

function seedParticles(input: DriftInput, n: number, rng: ReturnType<typeof createRng>): LatLon[] {
  const multi = (input.seedRings ?? []).filter((r) => r && r.length >= 4);
  const rings = multi.length ? multi : input.seedRing && input.seedRing.length >= 4 ? [input.seedRing] : [];
  const out: LatLon[] = [];
  if (rings.length) {
    const lons = rings.flatMap((r) => r.map((p) => p[0]));
    const lats = rings.flatMap((r) => r.map((p) => p[1]));
    const minLon = Math.min(...lons), maxLon = Math.max(...lons);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    let tries = 0;
    while (out.length < n && tries < n * 400) {
      tries++;
      const lon = minLon + rng.uniform() * (maxLon - minLon);
      const lat = minLat + rng.uniform() * (maxLat - minLat);
      if (rings.some((r) => pointInRing(lon, lat, r))) out.push([lat, lon]);
    }
  }
  const [lat0, lon0] = input.seedPoint;
  while (out.length < n) {
    // fallback: 300 m Gaussian cloud around the seed point
    out.push([lat0 + (rng.gauss() * 300) / M_PER_DEG_LAT, lon0 + (rng.gauss() * 300) / mPerDegLon(lat0)]);
  }
  return out;
}

function tally(counter: Record<string, number>, status: SampleStatus) {
  counter[status] = (counter[status] ?? 0) + 1;
}

function fractions(counter: Record<string, number>): Record<string, number> {
  const total = Object.values(counter).reduce((s, x) => s + x, 0) || 1;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(counter)) out[k] = round(v / total, 4);
  return out;
}

function realFraction(counter: Record<string, number>): number {
  const total = Object.values(counter).reduce((s, x) => s + x, 0) || 1;
  return (counter["REAL"] ?? 0) / total;
}

function snapshotOf(
  positions: LatLon[],
  startCentroid: LatLon,
  signedHours: number,
  timeIso: string,
  maxParticles: number,
  windCounter: Record<string, number>,
  currentCounter: Record<string, number>,
  env: EnvironmentModel,
): DriftSnapshot {
  const cLat = mean(positions.map((p) => p[0]));
  const cLon = mean(positions.map((p) => p[1]));
  const dists = positions.map((p) => haversineKm(p[0], p[1], cLat, cLon));
  const sorted = dists.slice().sort((a, b) => a - b);
  const r50 = percentile(sorted, 0.5);
  const r90 = percentile(sorted, 0.9);
  const core: LonLat[] = positions.filter((_, i) => dists[i] <= r90 + 1e-9).map((p) => [p[1], p[0]]);
  const hull = convexHull(core).map((p) => [round(p[0], 6), round(p[1], 6)] as LonLat);
  const displacement = haversineKm(startCentroid[0], startCentroid[1], cLat, cLon);
  const stride = Math.max(1, Math.ceil(positions.length / maxParticles));
  const hoursAbs = Math.abs(signedHours);
  return {
    hours: round(hoursAbs, 3),
    signed_hours: round(signedHours, 3),
    time: timeIso,
    centroid: [round(cLat, 6), round(cLon, 6)],
    r50_km: round(r50, 3),
    r90_km: round(r90, 3),
    hull,
    hull_area_km2: round(hull.length >= 4 ? ringAreaKm2(hull) : 0, 3),
    particles: positions.filter((_, i) => i % stride === 0).map((p) => [round(p[1], 5), round(p[0], 5)] as LonLat),
    displacement_km: round(displacement, 3),
    displacement_bearing_deg: round(
      displacement > 1e-6 ? bearingDeg(startCentroid[0], startCentroid[1], cLat, cLon) : 0,
      1,
    ),
    mean_drift_speed_ms: round(hoursAbs > 0 ? (displacement * 1000) / (hoursAbs * 3600) : 0, 4),
    wind_real_fraction: round(realFraction(windCounter), 4),
    current_real_fraction: round(realFraction(currentCounter), 4),
    forcing_support: forcingSupport(env, realFraction(windCounter), realFraction(currentCounter)),
  };
}

const MIN_REAL_FRACTION = 0.5;

function forcingSupport(env: EnvironmentModel, windReal: number, curReal: number): DriftSnapshot["forcing_support"] {
  const w = round(windReal, 4);
  const c = round(curReal, 4);
  if (env.wind.kind === "constant" || env.current.kind === "constant")
    return { supported: null, wind_real_fraction: w, current_real_fraction: c, reason: "synthetic demo forcing (constant vectors): not a real-forcing forecast" };
  const problems: string[] = [];
  if (env.wind.kind === "none") problems.push("no wind product");
  else if (windReal < MIN_REAL_FRACTION) problems.push(`wind is only ${(windReal * 100).toFixed(0)} % REAL (rest PERSISTED/EDGE_CLAMPED)`);
  if (env.current.kind === "none") problems.push("no ocean-current product (CURRENT_DATA_UNAVAILABLE)");
  else if (curReal < MIN_REAL_FRACTION) problems.push(`current is only ${(curReal * 100).toFixed(0)} % REAL`);
  return problems.length
    ? { supported: false, wind_real_fraction: w, current_real_fraction: c, reason: `NOT SUPPORTED by forcing coverage: ${problems.join("; ")}` }
    : { supported: true, wind_real_fraction: w, current_real_fraction: c, reason: "wind and current samples are >= 50 % REAL" };
}

export function runDrift(input: DriftInput, overrides: Partial<DriftParams> = {}): DriftResult {
  const p: DriftParams = { ...DEFAULT_DRIFT_PARAMS, ...overrides };
  if (!(p.hours > 0)) throw new Error("drift hours must be > 0");
  {
    const [sLat, sLon] = input.seedPoint ?? [NaN, NaN];
    if (!Number.isFinite(sLat) || !Number.isFinite(sLon) || Math.abs(sLat) > 90 || Math.abs(sLon) > 180) {
      throw new Error(`Invalid seed coordinates (lat ${sLat}, lon ${sLon})`);
    }
  }
  if (!(p.numParticles >= 1)) throw new Error("numParticles must be >= 1");
  const startMs = Date.parse(input.startTimeIso);
  if (!Number.isFinite(startMs)) throw new Error(`invalid start time: ${input.startTimeIso}`);

  const dir = p.mode === "BACKWARD" ? -1 : 1;
  const dtS = Math.max(MIN_DT_S, p.timestepMinutes * 60);
  const nSteps = Math.max(1, Math.ceil((p.hours * 3600) / dtS));
  const rng = createRng(p.seed);

  const positions = seedParticles(input, Math.floor(p.numParticles), rng);
  const startCentroid: LatLon = [mean(positions.map((q) => q[0])), mean(positions.map((q) => q[1]))];

  const currentUnavailable = input.env.current.kind === "none";
  const applyPrior = currentUnavailable && p.unknownCurrentSigma > 0;
  const prior = positions.map(() =>
    applyPrior ? [rng.gauss() * p.unknownCurrentSigma, rng.gauss() * p.unknownCurrentSigma] : [0, 0],
  );

  const diffStd = Math.sqrt(2 * Math.max(0, p.eddyDiffusivity) * dtS);
  const nTracks = Math.min(p.storedTracks, positions.length);
  const trackStride = Math.max(1, Math.floor(positions.length / Math.max(1, nTracks)));
  const trackIdx = new Set<number>();
  for (let i = 0; i < positions.length && trackIdx.size < nTracks; i += trackStride) trackIdx.add(i);
  const tracks: Map<number, LonLat[]> = new Map();
  for (const i of trackIdx) tracks.set(i, [[round(positions[i][1], 6), round(positions[i][0], 6)]]);

  const windCounter: Record<string, number> = {};
  const currentCounter: Record<string, number> = {};

  const velocity = (lat: number, lon: number, tMs: number, i: number, count: boolean): [number, number] => {
    const w = sampleField(input.env.wind, lat, lon, tMs);
    const c = sampleField(input.env.current, lat, lon, tMs);
    if (count) {
      tally(windCounter, w.status);
      tally(currentCounter, c.status);
    }
    const [wu, wv] = rotateWind(w.u, w.v, p.deflectionDeg, lat);
    return [p.currentScale * c.u + prior[i][0] + p.windFactor * wu, p.currentScale * c.v + prior[i][1] + p.windFactor * wv];
  };

  const snapshotSteps = new Map<number, number>();
  for (const h of p.snapshotHours) {
    if (h > 0 && h <= p.hours + 1e-9) snapshotSteps.set(Math.min(nSteps, Math.round((h * 3600) / dtS)), h);
  }

  const snapshots: DriftSnapshot[] = [];
  const centroidPath: CentroidPathPoint[] = [];
  const pushPath = (step: number) => {
    const cLat = mean(positions.map((q) => q[0]));
    const cLon = mean(positions.map((q) => q[1]));
    const d = positions.map((q) => haversineKm(q[0], q[1], cLat, cLon)).sort((a, b) => a - b);
    const signed = (dir * step * dtS) / 3600;
    centroidPath.push({
      signed_hours: round(signed, 3),
      time: new Date(startMs + signed * 3600 * 1000).toISOString(),
      lat: round(cLat, 6),
      lon: round(cLon, 6),
      r50_km: round(percentile(d, 0.5), 3),
      r90_km: round(percentile(d, 0.9), 3),
    });
  };
  pushPath(0);

  for (let step = 1; step <= nSteps; step++) {
    const t0 = startMs + dir * (step - 1) * dtS * 1000;
    const tMid = t0 + dir * 0.5 * dtS * 1000;
    for (let i = 0; i < positions.length; i++) {
      const [lat, lon] = positions[i];
      const [u1, v1] = velocity(lat, lon, t0, i, false);
      const midLat = lat + (dir * v1 * 0.5 * dtS) / M_PER_DEG_LAT;
      const midLon = lon + (dir * u1 * 0.5 * dtS) / mPerDegLon(lat);
      const [u2, v2] = velocity(midLat, midLon, tMid, i, true);
      const dx = dir * u2 * dtS + rng.gauss() * diffStd;
      const dy = dir * v2 * dtS + rng.gauss() * diffStd;
      const newLat = lat + dy / M_PER_DEG_LAT;
      const newLon = lon + dx / mPerDegLon(0.5 * (lat + newLat));
      positions[i] = [newLat, newLon];
      const tr = tracks.get(i);
      if (tr) tr.push([round(newLon, 6), round(newLat, 6)]);
    }
    pushPath(step);
    if (snapshotSteps.has(step)) {
      const h = snapshotSteps.get(step)!;
      const signed = dir * h;
      snapshots.push(
        snapshotOf(
          positions,
          startCentroid,
          signed,
          new Date(startMs + signed * 3600 * 1000).toISOString(),
          p.maxSnapshotParticles,
          windCounter,
          currentCounter,
          input.env,
        ),
      );
    }
  }

  const signedEnd = (dir * nSteps * dtS) / 3600;
  const endIso = new Date(startMs + signedEnd * 3600 * 1000).toISOString();
  const final = snapshotOf(positions, startCentroid, signedEnd, endIso, p.maxSnapshotParticles, windCounter, currentCounter, input.env);

  const windFr = fractions(windCounter);
  const curFr = fractions(currentCounter);
  const warnings: string[] = [];
  const windReal = windFr["REAL"] ?? 0;
  if (input.env.wind.kind === "none") warnings.push("No wind product available: wind drift term set to zero.");
  else if (input.env.wind.kind === "gridded" && windReal < 0.5)
    warnings.push(
      `Only ${(windReal * 100).toFixed(0)} % of wind samples fall inside the ERA5 product's time/space coverage; the rest are PERSISTED or EDGE_CLAMPED. Extend the ERA5 download window.`,
    );
  if (input.env.wind.kind === "constant")
    warnings.push(`Wind is a single constant vector (${input.env.wind.status}); no spatial or temporal variability.`);
  if (currentUnavailable)
    warnings.push(
      applyPrior
        ? `No ocean-current product: current treated as an unknown zero-mean prior (sigma ${p.unknownCurrentSigma} m/s per component). The envelope reflects this uncertainty; the centroid does NOT include current advection.`
        : "No ocean-current product and no current prior: drift is wind-only; uncertainty is underestimated.",
    );
  if (p.currentScale !== 1 && input.env.current.kind !== "none")
    warnings.push(`Current product scaled x${p.currentScale}: a WHAT-IF sensitivity case, not data.`);
  if (input.env.current.kind === "constant")
    warnings.push(`Current is a single constant vector (${input.env.current.status}).`);

  return {
    mode: p.mode,
    start_time: new Date(startMs).toISOString(),
    end_time: endIso,
    hours: round((nSteps * dtS) / 3600, 3),
    timestep_minutes: round(dtS / 60, 3),
    num_particles: positions.length,
    seed: p.seed,
    start_centroid: [round(startCentroid[0], 6), round(startCentroid[1], 6)],
    final,
    snapshots,
    centroid_path: centroidPath,
    tracks: Array.from(tracks.values()),
    forcing: {
      wind_factor: p.windFactor,
      deflection_deg: p.deflectionDeg,
      deflection_sense: "clockwise (to the right of the wind) in the northern hemisphere; counter-clockwise in the southern hemisphere",
      eddy_diffusivity_m2s: p.eddyDiffusivity,
      unknown_current_prior_sigma_ms: applyPrior ? p.unknownCurrentSigma : 0,
      current_prior_applied: applyPrior,
      current_scale: p.currentScale,
      wind_status_fractions: windFr,
      current_status_fractions: curFr,
      integration: `RK2 midpoint, dt = ${round(dtS / 60, 2)} min, ${nSteps} steps, seed ${p.seed}`,
    },
    warnings,
    model_limitations: [
      "2-D surface transport only: no weathering, evaporation, emulsification, entrainment or beaching.",
      "No wave-induced Stokes drift term.",
      "Hull areas are transport envelopes of the P90 particle core, not oil-thickness or mass footprints.",
    ],
  };
}
