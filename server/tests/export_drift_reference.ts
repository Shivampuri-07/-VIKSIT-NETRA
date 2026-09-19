/**
 * Exports reference results of the operational TypeScript drift engine for the
 * Python cross-language consistency test (tests/test_drift_lagrangian.py).
 *
 *   npx tsx server/tests/export_drift_reference.ts   ->  tests/fixtures/ts_drift_reference.json
 *
 * Scenarios use CONSTANT forcing only, because the Python model supports only
 * constant forcing. Deterministic scenarios switch noise off (K = 0, prior 0).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { runDrift } from "../lib/drift";
import type { FieldSource } from "../lib/environment";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const C = (u: number, v: number): FieldSource => ({ kind: "constant", u, v, status: "USER_OVERRIDE", label: "reference" });
const NONE: FieldSource = { kind: "none", label: "no product" };

interface Scenario {
  id: string; description: string; mode: "FORWARD" | "BACKWARD"; lat: number; lon: number;
  hours: number; dt_min: number; wind: [number, number] | null; current: [number, number] | null;
  K: number; sigma: number; n: number; deterministic: boolean;
}
const scenarios: Scenario[] = [
  { id: "current_east_1ms_1h", description: "1 m/s eastward current, 1 h", mode: "FORWARD", lat: 10, lon: 50, hours: 1, dt_min: 30, wind: null, current: [1, 0], K: 0, sigma: 0, n: 4, deterministic: true },
  { id: "wind_north_NH", description: "10 m/s wind toward north at 30N: drift 5 deg right of wind", mode: "FORWARD", lat: 30, lon: 0, hours: 6, dt_min: 30, wind: [0, 10], current: [0, 0], K: 0, sigma: 0, n: 4, deterministic: true },
  { id: "wind_north_SH", description: "10 m/s wind toward north at 30S: drift 5 deg left of wind", mode: "FORWARD", lat: -30, lon: 0, hours: 6, dt_min: 30, wind: [0, 10], current: [0, 0], K: 0, sigma: 0, n: 4, deterministic: true },
  { id: "backward_era5_like_gom", description: "ERA5-like wind at the GoM slick (14:00 UTC field) plus a user current, BACKWARD 12 h", mode: "BACKWARD", lat: 28.904745, lon: -89.02427, hours: 12, dt_min: 30, wind: [1.4775, 1.6377], current: [0.2, -0.1], K: 0, sigma: 0, n: 4, deterministic: true },
  { id: "forward_high_lat_48h", description: "0.5 m/s NE current at 60N for 48 h (metres-to-degrees at changing latitude)", mode: "FORWARD", lat: 60, lon: 5, hours: 48, dt_min: 30, wind: null, current: [0.5, 0.5], K: 0, sigma: 0, n: 4, deterministic: true },
  { id: "non_multiple_duration", description: "10 h at 45 min steps -> 14 steps = 10.5 h", mode: "FORWARD", lat: 28.9, lon: -89, hours: 10, dt_min: 45, wind: [3, 4], current: [0.1, 0.05], K: 0, sigma: 0, n: 4, deterministic: true },
  { id: "diffusion_only_K10", description: "diffusion K = 10 m2/s for 10 h, 300 m seed cloud", mode: "FORWARD", lat: 10, lon: 50, hours: 10, dt_min: 30, wind: [0, 0], current: [0, 0], K: 10, sigma: 0, n: 3000, deterministic: false },
  { id: "unknown_current_prior", description: "no current product: zero-mean prior sigma 0.1 m/s for 12 h, no diffusion", mode: "BACKWARD", lat: 28.9, lon: -89, hours: 12, dt_min: 30, wind: [0, 0], current: null, K: 0, sigma: 0.1, n: 3000, deterministic: false },
];

const out = scenarios.map((s) => {
  const r = runDrift(
    { startTimeIso: "2020-01-01T00:00:00Z", seedRing: null, seedPoint: [s.lat, s.lon], env: { wind: s.wind ? C(s.wind[0], s.wind[1]) : NONE, current: s.current ? C(s.current[0], s.current[1]) : NONE } },
    { mode: s.mode, hours: s.hours, timestepMinutes: s.dt_min, numParticles: s.n, windFactor: 0.03, deflectionDeg: 5, eddyDiffusivity: s.K, unknownCurrentSigma: s.sigma, seed: 7 },
  );
  return {
    ...s,
    ts: {
      simulated_hours: r.hours,
      d_lat: r.final.centroid[0] - r.start_centroid[0],
      d_lon: r.final.centroid[1] - r.start_centroid[1],
      displacement_km: r.final.displacement_km,
      bearing_deg: r.final.displacement_bearing_deg,
      r50_km: r.final.r50_km,
      r90_km: r.final.r90_km,
      current_prior_applied: r.forcing.current_prior_applied,
      end_time: r.end_time,
    },
  };
});
const file = path.join(ROOT, "tests", "fixtures", "ts_drift_reference.json");
fs.writeFileSync(file, JSON.stringify({ generated_by: "server/tests/export_drift_reference.ts", engine: "server/lib/drift.ts", wind_factor: 0.03, deflection_deg: 5, scenarios: out }, null, 1));
console.log(`wrote ${file}`);
for (const o of out) console.log(o.id.padEnd(26), "hours", o.ts.simulated_hours, "disp", o.ts.displacement_km, "km bearing", o.ts.bearing_deg, "r50", o.ts.r50_km, "r90", o.ts.r90_km);
