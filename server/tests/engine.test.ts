/**
 * AEGIS engine tests. Run with:  npm run test:engine
 * (tsx --test server/tests/*.test.ts)
 *
 * These tests execute the real engines on the real bundled data.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "path";
import { fileURLToPath } from "url";
import {
  haversineKm, bearingDeg, vectorBearingTo, windDirectionFrom, axialDifference,
  ringAreaKm2, pointInRing, convexHull, createRng, offsetMeters, LonLat,
} from "../lib/geo";
import { sampleField, FieldSource, GriddedField } from "../lib/environment";
import { runDrift } from "../lib/drift";
import { groupTracks, parseMarineCadastreCsv, positionAt, parseUtc } from "../lib/ais";
import { scoreCandidates, reproduceOfflineScore, normalizeWeights } from "../lib/attribution";
import { SceneService, REAL_SCENE_ID } from "../lib/scenes";
import { createInvestigation, defaultParams, executeInvestigation, NODES } from "../lib/investigation";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const svc = new SceneService(ROOT);

// ------------------------------------------------------------------ geo
test("haversine: 1 degree of latitude ~ 111.2 km", () => {
  assert.ok(Math.abs(haversineKm(0, 0, 1, 0) - 111.19) < 0.1);
});

test("compass bearings: vector (u east, v north) conventions", () => {
  assert.equal(Math.round(vectorBearingTo(0, 1)), 0); // toward north
  assert.equal(Math.round(vectorBearingTo(1, 0)), 90); // toward east
  assert.equal(Math.round(vectorBearingTo(0, -1)), 180);
  assert.equal(Math.round(vectorBearingTo(-1, 0)), 270);
  assert.equal(Math.round(windDirectionFrom(0, 1)), 180); // southerly wind blows toward north
  assert.equal(Math.round(bearingDeg(0, 0, 0, 1)), 90);
});

test("axial difference treats opposite directions as the same axis", () => {
  assert.ok(Math.abs(axialDifference(233.7, 53.7)) < 1e-9);
  assert.ok(Math.abs(axialDifference(10, 170) - 20) < 1e-9);
});

test("ring area: 0.1 x 0.1 degree box at the equator ~ 123.6 km2", () => {
  const box: LonLat[] = [[0, 0], [0.1, 0], [0.1, 0.1], [0, 0.1], [0, 0]];
  assert.ok(Math.abs(ringAreaKm2(box) - 123.6) < 1.0);
  assert.ok(pointInRing(0.05, 0.05, box));
  assert.ok(!pointInRing(0.15, 0.05, box));
});

test("convex hull of a square with an interior point", () => {
  const h = convexHull([[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0.5]]);
  assert.equal(h.length, 5);
});

test("seeded RNG is reproducible and ~standard normal", () => {
  const a = createRng(7), b = createRng(7);
  const xs = Array.from({ length: 20000 }, () => a.gauss());
  assert.equal(b.gauss(), xs[0]);
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length;
  assert.ok(Math.abs(m) < 0.03 && Math.abs(v - 1) < 0.05);
});

test("offsetMeters: 1000 m north then back", () => {
  const [lat, lon] = offsetMeters(28.9, -89, 0, 1000);
  assert.ok(Math.abs(haversineKm(28.9, -89, lat, lon) - 1) < 1e-3);
});

// ------------------------------------------------------------------ environment
const field: GriddedField = {
  schema: "t", kind: "wind10m", source: "test", units: "m s-1",
  times: ["2020-01-01T00:00:00Z", "2020-01-01T01:00:00Z"],
  lats: [1, 0], lons: [0, 1],
  u: [[[0, 1], [2, 3]], [[10, 11], [12, 13]]],
  v: [[[0, 0], [0, 0]], [[0, 0], [0, 0]]],
};
const src: FieldSource = { kind: "gridded", field, label: "test", timesMs: field.times.map(Date.parse) };

test("environment: bilinear in space (decreasing lat axis)", () => {
  const s = sampleField(src, 0.5, 0.5, Date.parse(field.times[0]));
  assert.equal(s.status, "REAL");
  assert.ok(Math.abs(s.u - 1.5) < 1e-12);
});

test("environment: linear in time", () => {
  const s = sampleField(src, 1, 0, Date.parse("2020-01-01T00:30:00Z"));
  assert.ok(Math.abs(s.u - 5) < 1e-12);
});

test("environment: outside time range is PERSISTED, outside grid is EDGE_CLAMPED", () => {
  assert.equal(sampleField(src, 0.5, 0.5, Date.parse("2020-01-01T05:00:00Z")).status, "PERSISTED");
  assert.equal(sampleField(src, 5, 0.5, Date.parse(field.times[0])).status, "EDGE_CLAMPED");
  assert.equal(sampleField({ kind: "none", label: "x" }, 0, 0, 0).status, "NOT_AVAILABLE");
});

test("real ERA5 field: nearest-cell values equal the values recorded from the NetCDF", () => {
  const env = svc.environment(REAL_SCENE_ID);
  const s14 = sampleField(env.wind, 29.0, -89.0, Date.parse("2018-09-26T14:00:00Z"));
  const s15 = sampleField(env.wind, 29.0, -89.0, Date.parse("2018-09-26T15:00:00Z"));
  assert.ok(Math.abs(s14.u - 1.6974) < 1e-4 && Math.abs(s14.v - 1.5915) < 1e-4);
  assert.ok(Math.abs(s15.u - 2.0773) < 1e-4 && Math.abs(s15.v - 1.6585) < 1e-4);
});

// ------------------------------------------------------------------ drift
const constEnv = (wu: number, wv: number, cu = 0, cv = 0) => ({
  wind: { kind: "constant", u: wu, v: wv, status: "USER_OVERRIDE", label: "t" } as FieldSource,
  current: { kind: "constant", u: cu, v: cv, status: "USER_OVERRIDE", label: "t" } as FieldSource,
});
const noise0 = { eddyDiffusivity: 0, unknownCurrentSigma: 0, numParticles: 20, deflectionDeg: 0 };

test("drift: pure eastward current 1 m/s for 1 h moves ~3.6 km east (FORWARD)", () => {
  const r = runDrift({ startTimeIso: "2020-01-01T00:00:00Z", seedRing: null, seedPoint: [10, 50], env: constEnv(0, 0, 1, 0) }, { ...noise0, mode: "FORWARD", hours: 1 });
  assert.ok(Math.abs(r.final.displacement_km - 3.6) < 0.01, `got ${r.final.displacement_km}`);
  assert.ok(Math.abs(r.final.displacement_bearing_deg - 90) < 0.5);
});

test("drift: BACKWARD moves opposite to the flow", () => {
  const r = runDrift({ startTimeIso: "2020-01-01T00:00:00Z", seedRing: null, seedPoint: [10, 50], env: constEnv(0, 0, 0, 0.5) }, { ...noise0, mode: "BACKWARD", hours: 2 });
  assert.ok(Math.abs(r.final.displacement_km - 3.6) < 0.01);
  assert.ok(Math.abs(r.final.displacement_bearing_deg - 180) < 0.5);
  assert.ok(Date.parse(r.end_time) < Date.parse(r.start_time));
});

test("drift: wind factor 3 % of 10 m/s northward wind = 0.3 m/s", () => {
  const r = runDrift({ startTimeIso: "2020-01-01T00:00:00Z", seedRing: null, seedPoint: [0.001, 0], env: constEnv(0, 10) }, { ...noise0, mode: "FORWARD", hours: 1, windFactor: 0.03 });
  assert.ok(Math.abs(r.final.displacement_km - 1.08) < 0.01);
});

test("drift: deflection is to the RIGHT of the wind in the northern hemisphere, LEFT in the southern", () => {
  const nh = runDrift({ startTimeIso: "2020-01-01T00:00:00Z", seedRing: null, seedPoint: [30, 0], env: constEnv(0, 10) }, { ...noise0, deflectionDeg: 10, mode: "FORWARD", hours: 1 });
  const sh = runDrift({ startTimeIso: "2020-01-01T00:00:00Z", seedRing: null, seedPoint: [-30, 0], env: constEnv(0, 10) }, { ...noise0, deflectionDeg: 10, mode: "FORWARD", hours: 1 });
  assert.ok(Math.abs(nh.final.displacement_bearing_deg - 10) < 0.5, `NH ${nh.final.displacement_bearing_deg}`);
  assert.ok(Math.abs(sh.final.displacement_bearing_deg - 350) < 0.5, `SH ${sh.final.displacement_bearing_deg}`);
});

test("drift: diffusion spread matches sqrt(2 K t)", () => {
  const r = runDrift({ startTimeIso: "2020-01-01T00:00:00Z", seedRing: null, seedPoint: [10, 50], env: constEnv(0, 0) },
    { mode: "FORWARD", hours: 10, numParticles: 2000, eddyDiffusivity: 10, unknownCurrentSigma: 0, maxSnapshotParticles: 5000 });
  // per-axis sigma = sqrt(2*10*36000) = 848.5 m, plus 300 m seed cloud => sqrt(848.5^2+300^2) = 900 m
  // median radial distance of a 2-D Gaussian = sigma * sqrt(2 ln 2) = 1.1774 sigma
  const expected = 0.9 * 1.1774;
  assert.ok(Math.abs(r.final.r50_km - expected) / expected < 0.08, `r50 ${r.final.r50_km} expected ${expected}`);
});

test("drift: timestep independence for constant forcing", () => {
  const a = runDrift({ startTimeIso: "2020-01-01T00:00:00Z", seedRing: null, seedPoint: [10, 50], env: constEnv(5, 5, 0.2, 0.1) }, { ...noise0, mode: "FORWARD", hours: 6, timestepMinutes: 5 });
  const b = runDrift({ startTimeIso: "2020-01-01T00:00:00Z", seedRing: null, seedPoint: [10, 50], env: constEnv(5, 5, 0.2, 0.1) }, { ...noise0, mode: "FORWARD", hours: 6, timestepMinutes: 60 });
  assert.ok(Math.abs(a.final.displacement_km - b.final.displacement_km) < 0.01);
});

test("drift: snapshots at requested forecast horizons with growing envelopes", () => {
  const det = svc.detect(REAL_SCENE_ID);
  const r = runDrift({ startTimeIso: det.detection_time, seedRing: det.geometry.coordinates, seedPoint: det.geometry.centroid, env: svc.environment(REAL_SCENE_ID) },
    { mode: "FORWARD", hours: 48, snapshotHours: [6, 12, 24, 48] });
  assert.deepEqual(r.snapshots.map((s) => s.hours), [6, 12, 24, 48]);
  for (let i = 1; i < r.snapshots.length; i++) assert.ok(r.snapshots[i].r90_km > r.snapshots[i - 1].r90_km);
  // A real historical current product (HYCOM 2018 analysis) is connected; the wind (ERA5, 2 hourly fields) is what limits the forecast.
  assert.ok((r.forcing.current_status_fractions["REAL"] ?? 0) > 0.8, "the real current covers the 48 h forecast window");
  assert.ok(r.warnings.some((w) => /wind/i.test(w)), "wind persistence is warned about");
  assert.ok((r.forcing.wind_status_fractions["REAL"] ?? 0) < 0.1, "real ERA5 only covers 1 h of 48 h");
  assert.ok(r.snapshots.every((s) => s.forcing_support.supported === false), "no horizon is supported by real forcing coverage");
  assert.ok(r.snapshots.every((s) => /NOT SUPPORTED/.test(s.forcing_support.reason)));
});

// ------------------------------------------------------------------ AIS / attribution
test("AIS: MarineCadastre timestamps parsed as UTC", () => {
  assert.equal(new Date(parseUtc("2018-09-26 17:21:38")).toISOString(), "2018-09-26T17:21:38.000Z");
  assert.equal(new Date(parseUtc("2018-09-26 14:21:29+00:00")).toISOString(), "2018-09-26T14:21:29.000Z");
});

test("AIS: interpolation does not bridge long gaps", () => {
  const tr = groupTracks(parseMarineCadastreCsv(
    "mmsi,base_date_time,longitude,latitude,sog,cog\n1,2020-01-01 00:00:00,0,0,10,90\n1,2020-01-01 00:10:00,0.1,0,10,90\n1,2020-01-01 02:00:00,0.5,0,10,90\n",
  ))[0];
  const p = positionAt(tr, Date.parse("2020-01-01T00:05:00Z"))!;
  assert.ok(Math.abs(p.lon - 0.05) < 1e-9);
  assert.equal(positionAt(tr, Date.parse("2020-01-01T01:00:00Z")), null);
});

test("attribution: reproduces the 2018 offline baseline scores for all vessels", () => {
  const ais = svc.ais(REAL_SCENE_ID);
  const base = svc.baseline(REAL_SCENE_ID);
  assert.ok(ais.tracks.length === 87 && base.size === 87);
  let compared = 0;
  for (const tr of ais.tracks) {
    const b = base.get(tr.mmsi);
    const r = reproduceOfflineScore(tr, [28.9047446258, -89.0242701655], Date.parse("2018-09-26T14:24:00Z"), 233.7, 94.9123216749952);
    if (b === undefined || r === null) continue;
    compared++;
    assert.ok(Math.abs(r - b) < 0.01, `${tr.mmsi}: ${r} vs ${b}`);
  }
  assert.ok(compared >= 85);
});

test("attribution: user weights change the composite (weights are applied)", () => {
  const det = svc.detect(REAL_SCENE_ID);
  const env = svc.environment(REAL_SCENE_ID);
  const back = runDrift({ startTimeIso: det.detection_time, seedRing: det.geometry.coordinates, seedPoint: det.geometry.centroid, env }, { mode: "BACKWARD", hours: 12 });
  const ais = svc.ais(REAL_SCENE_ID);
  const ctx = { obsTimeMs: Date.parse(det.detection_time), slickRing: det.geometry.coordinates, slickCentroid: det.geometry.centroid, slickAxisDeg: det.geometry.orientation_deg, corridor: back.centroid_path, horizonHours: 12, aisBbox: ais.bbox, baseline: svc.baseline(REAL_SCENE_ID), dataSourceLabel: ais.label };
  const a = scoreCandidates(ais.tracks, ctx, { spatial: 1, temporal: 0, trajectory: 0, consistency: 0 });
  const b = scoreCandidates(ais.tracks, ctx, { spatial: 0, temporal: 0, trajectory: 0, consistency: 1 });
  const va = a.candidates.find((c) => c.vessel_name === "MSC LEIGH")!;
  const vb = b.candidates.find((c) => c.vessel_name === "MSC LEIGH")!;
  assert.equal(va.composite_score, va.feature_breakdown.spatial_proximity_score);
  assert.equal(vb.composite_score, vb.feature_breakdown.kinematic_consistency_score);
  // every candidate carries the non-legal disclaimer and factor evidence
  for (const c of a.candidates) {
    assert.equal(c.causality_status, "NOT CONFIRMED");
    assert.match(c.scientific_disclaimer, /does NOT establish/);
    assert.ok(Number.isFinite(c.metrics.cpa_coordinates[0]) && c.metrics.cpa_coordinates[0] !== 0);
  }
  const w = normalizeWeights({ spatial: 2, temporal: 2, trajectory: 0, consistency: 0 });
  assert.equal(w.spatial, 0.5);
});

test("attribution: MSC LEIGH first reported inside the AIS box after the slick existed -> penalised timing", () => {
  const det = svc.detect(REAL_SCENE_ID);
  const env = svc.environment(REAL_SCENE_ID);
  const back = runDrift({ startTimeIso: det.detection_time, seedRing: det.geometry.coordinates, seedPoint: det.geometry.centroid, env }, { mode: "BACKWARD", hours: 12 });
  const ais = svc.ais(REAL_SCENE_ID);
  const res = scoreCandidates(ais.tracks, { obsTimeMs: Date.parse(det.detection_time), slickRing: det.geometry.coordinates, slickCentroid: det.geometry.centroid, slickAxisDeg: 233.7, corridor: back.centroid_path, horizonHours: 12, aisBbox: ais.bbox, baseline: svc.baseline(REAL_SCENE_ID), dataSourceLabel: ais.label }, {});
  const m = res.candidates.find((c) => c.vessel_name === "MSC LEIGH")!;
  assert.ok(m.ais_quality.first_report >= "2018-09-26T14:21");
  assert.ok(m.metrics.time_delta_hours > 0, "closest approach after T0");
  assert.ok(m.contradicting_evidence.some((x) => /AFTER the SAR observation/.test(x)));
});

// ------------------------------------------------------------------ investigation graph
test("investigation graph executes every node on the real scene and emits ordered events", async () => {
  const inv = createInvestigation(defaultParams(REAL_SCENE_ID, { num_particles: 150 }));
  await executeInvestigation(inv, svc);
  assert.equal(inv.status, "completed");
  for (const n of NODES) assert.equal(inv.node_status[n.id], "completed", n.id);
  const seqs = inv.events.map((e) => e.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.equal(inv.state.hypotheses!.length, 4);
  assert.ok(inv.state.forward!.snapshots.length === 4);
  assert.ok(inv.state.environment!.low_wind_lookalike_risk === true, "ERA5 wind at T0 is ~2.4 m/s");
  assert.ok(inv.state.recommendations!.length > 0);
  assert.ok(inv.state.report!.disclaimer.includes("No output of this system constitutes proof"));
});

test("investigation graph: re-run from evidence_fusion with new weights keeps upstream state", async () => {
  const inv = createInvestigation(defaultParams(REAL_SCENE_ID, { num_particles: 100 }));
  await executeInvestigation(inv, svc);
  const before = inv.state.backward!.final.centroid;
  inv.state.params.weights = normalizeWeights({ spatial: 0, temporal: 0, trajectory: 1, consistency: 0 });
  await executeInvestigation(inv, svc, "evidence_fusion");
  assert.deepEqual(inv.state.backward!.final.centroid, before);
  const top = inv.state.attribution!.candidates[0];
  assert.equal(top.composite_score, top.feature_breakdown.trajectory_intersection_score);
});

test("investigation graph runs on a synthetic demo scene and labels it", async () => {
  const demo = svc.listScenes().find((s) => s.synthetic)!;
  const inv = createInvestigation(defaultParams(demo.scene_id, { num_particles: 60 }));
  await executeInvestigation(inv, svc);
  assert.equal(inv.status, "completed");
  assert.ok(inv.state.detection!.synthetic);
  assert.ok(inv.state.attribution!.candidates.every((c) => c.synthetic && /SYNTHETIC/.test(c.vessel_name)));
});

test("investigation graph: unknown scene fails detection and routes straight to report", async () => {
  const inv = createInvestigation(defaultParams("NO_SUCH_SCENE"));
  await executeInvestigation(inv, svc);
  assert.equal(inv.node_status["satellite_detection"], "failed");
  assert.equal(inv.node_status["forward_forecast"], "skipped");
  assert.equal(inv.node_status["report_generation"], "completed");
});
