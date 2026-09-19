/**
 * AEGIS web server (Express).
 *
 * Thin HTTP layer over the tested engines in server/lib/*. All science lives
 * in those modules; this file only validates input, routes, and serves the UI.
 *
 *   development:  tsx server.ts           (Vite middleware, HMR)
 *   production:   NODE_ENV=production node dist-server/server.cjs
 *                 (serves the Vite build from dist/)
 */
import express, { Request, Response, NextFunction } from "express";
import path from "path";
import fs from "fs";
import { SceneService, REAL_SCENE_ID } from "./server/lib/scenes";
import { runDrift, DriftResult } from "./server/lib/drift";
import { scoreCandidates, normalizeWeights, reproduceOfflineScore } from "./server/lib/attribution";
import { sampleField, gridVectors, nativeTimeSeries } from "./server/lib/environment";
import { vectorBearingTo, windDirectionFrom, axialDifference, haversineKm } from "./server/lib/geo";
import {
  createInvestigation,
  defaultParams,
  executeInvestigation,
  getInvestigation,
  investigationView,
  NodeEvent,
} from "./server/lib/investigation";
import { toLegacyDrift, toLegacyAttribution, envSummaryFromInvestigation, LegacyEnvSummary } from "./server/lib/legacy";
import { excludeVessel, forcingSensitivity } from "./server/lib/counterfactual";
import { loadCapabilities } from "./server/lib/capabilities";
import { dataRootStatus } from "./server/lib/dataroot";
import { validateFeedback, addFeedback, listFeedback } from "./server/lib/review";

declare const __AEGIS_BUILD__: string | undefined;

// A compiled bundle (npm run build) always runs in production mode; `tsx server.ts` is development.
const BUNDLED_PRODUCTION = typeof __AEGIS_BUILD__ !== "undefined" && __AEGIS_BUILD__ === "production";
if (BUNDLED_PRODUCTION && !process.env.NODE_ENV) process.env.NODE_ENV = "production";

// Optional local .env (never required). Variables already set in the environment take precedence.
if (fs.existsSync(path.join(process.cwd(), ".env")) && typeof (process as any).loadEnvFile === "function") {
  try {
    (process as any).loadEnvFile(path.join(process.cwd(), ".env"));
  } catch (e) {
    console.warn(`[AEGIS] .env not loaded: ${(e as Error).message}`);
  }
}

const ROOT = process.cwd();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const IS_PROD = process.env.NODE_ENV === "production";
const VERSION = "2.0.0";

const svc = new SceneService(ROOT);

// CPU-heavy particle ensembles are capped so a public deployment cannot be saturated.
const MAX_JOBS = Math.max(1, Number(process.env.AEGIS_MAX_CONCURRENT_JOBS || 2));
let activeJobs = 0;
function acquireJob(res: Response): boolean {
  if (activeJobs >= MAX_JOBS) {
    res.setHeader("Retry-After", "5");
    res.status(429).json({ error: "Server busy: too many concurrent analyses. Retry shortly.", max_concurrent_jobs: MAX_JOBS });
    return false;
  }
  activeJobs++;
  return true;
}
function releaseJob() {
  activeJobs = Math.max(0, activeJobs - 1);
}

const state = {
  spills: new Map<number, any>(),
  simulations: new Map<number, { result: DriftResult; spill_id: number; legacy: any }>(),
  analyses: new Map<string, any>(),
  simCounter: 1,
  appMode: (process.env.APP_MODE || "REAL").toUpperCase() === "DEMO" ? "DEMO" : "REAL",
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function num(x: unknown, fallback: number, lo = -Infinity, hi = Infinity): number {
  const n = Number(x);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

function envSummary(sceneId: string, detection: any): LegacyEnvSummary {
  const env = svc.environment(sceneId);
  const [lat, lon] = detection.geometry.centroid;
  const t0 = Date.parse(detection.detection_time);
  const w = sampleField(env.wind, lat, lon, t0);
  const c = sampleField(env.current, lat, lon, t0);
  const desc = svc.environmentDescription(sceneId);
  const wOk = w.status !== "NOT_AVAILABLE";
  const cOk = c.status !== "NOT_AVAILABLE";
  const diff = wOk ? axialDifference(vectorBearingTo(w.u, w.v), detection.geometry.orientation_deg) : null;
  return {
    wind_u10_ms: wOk ? w.u : null,
    wind_v10_ms: wOk ? w.v : null,
    wind_speed_ms: wOk ? Math.hypot(w.u, w.v) : null,
    wind_direction_to_deg: wOk ? vectorBearingTo(w.u, w.v) : null,
    wind_direction_from_deg: wOk ? windDirectionFrom(w.u, w.v) : null,
    wind_status: w.status,
    current_uo_ms: cOk ? c.u : null,
    current_vo_ms: cOk ? c.v : null,
    current_speed_ms: cOk ? Math.hypot(c.u, c.v) : null,
    current_status: c.status,
    wind_slick_axis_difference_deg: diff,
    wind_slick_consistency: diff === null ? null : Math.max(0, 1 - diff / 90),
    wind_source_label: desc.wind.label,
    current_source_label: desc.current.label,
  };
}

function weightsFromQuery(q: any) {
  return normalizeWeights({
    spatial: num(q.weight_spatial, 0.35, 0, 100),
    temporal: num(q.weight_temporal, 0.25, 0, 100),
    trajectory: num(q.weight_trajectory, 0.25, 0, 100),
    consistency: num(q.weight_consistency, 0.15, 0, 100),
  });
}

function selfTest() {
  const results: { name: string; passed: boolean; detail: string }[] = [];
  const check = (name: string, fn: () => [boolean, string]) => {
    try {
      const [passed, detail] = fn();
      results.push({ name, passed, detail });
    } catch (e) {
      results.push({ name, passed: false, detail: `exception: ${(e as Error).message}` });
    }
  };
  const constEnv = (wu: number, wv: number, cu: number, cv: number) => ({
    wind: { kind: "constant" as const, u: wu, v: wv, status: "USER_OVERRIDE" as const, label: "selftest" },
    current: { kind: "constant" as const, u: cu, v: cv, status: "USER_OVERRIDE" as const, label: "selftest" },
  });
  const base = { eddyDiffusivity: 0, unknownCurrentSigma: 0, numParticles: 10, deflectionDeg: 0 };
  check("Compass convention: vector (u=1, v=0) points east (90°)", () => {
    const b = vectorBearingTo(1, 0);
    return [Math.abs(b - 90) < 1e-9, `${b.toFixed(2)}°`];
  });
  check("Forward drift: 1 m/s eastward current for 1 h → 3.6 km east", () => {
    const r = runDrift({ startTimeIso: "2020-01-01T00:00:00Z", seedRing: null, seedPoint: [10, 50], env: constEnv(0, 0, 1, 0) }, { ...base, mode: "FORWARD", hours: 1 });
    return [Math.abs(r.final.displacement_km - 3.6) < 0.01 && Math.abs(r.final.displacement_bearing_deg - 90) < 0.5, `${r.final.displacement_km} km toward ${r.final.displacement_bearing_deg}°`];
  });
  check("Backward drift moves against the flow", () => {
    const r = runDrift({ startTimeIso: "2020-01-01T00:00:00Z", seedRing: null, seedPoint: [10, 50], env: constEnv(0, 0, 1, 0) }, { ...base, mode: "BACKWARD", hours: 1 });
    return [Math.abs(r.final.displacement_bearing_deg - 270) < 0.5, `toward ${r.final.displacement_bearing_deg}°`];
  });
  check("Wind deflection is to the right in the northern hemisphere", () => {
    const r = runDrift({ startTimeIso: "2020-01-01T00:00:00Z", seedRing: null, seedPoint: [30, 0], env: constEnv(0, 10, 0, 0) }, { ...base, deflectionDeg: 10, mode: "FORWARD", hours: 1 });
    return [Math.abs(r.final.displacement_bearing_deg - 10) < 0.5, `drift toward ${r.final.displacement_bearing_deg}° for wind toward 0°`];
  });
  check("ERA5 field matches the NetCDF nearest-cell values", () => {
    const env = svc.environment(REAL_SCENE_ID);
    const s = sampleField(env.wind, 29.0, -89.0, Date.parse("2018-09-26T14:00:00Z"));
    return [s.status === "REAL" && Math.abs(s.u - 1.6974) < 1e-4 && Math.abs(s.v - 1.5915) < 1e-4, `u10=${s.u.toFixed(4)} v10=${s.v.toFixed(4)} (${s.status})`];
  });
  check("AIS engine reproduces the 2018 offline attribution scores", () => {
    const ais = svc.ais(REAL_SCENE_ID);
    const b = svc.baseline(REAL_SCENE_ID);
    let n = 0, worst = 0;
    for (const t of ais.tracks) {
      const r = reproduceOfflineScore(t, [28.9047446258, -89.0242701655], Date.parse("2018-09-26T14:24:00Z"), 233.7, 94.9123216749952);
      const v = b.get(t.mmsi);
      if (r === null || v === undefined) continue;
      n++;
      worst = Math.max(worst, Math.abs(r - v));
    }
    return [n > 80 && worst < 0.01, `${n} vessels compared, max |diff| = ${worst.toFixed(4)}`];
  });
  check("Geodesic distance: 1° latitude ≈ 111.2 km", () => {
    const d = haversineKm(0, 0, 1, 0);
    return [Math.abs(d - 111.19) < 0.1, `${d.toFixed(3)} km`];
  });
  return { passed: results.every((r) => r.passed), results, note: "In-process engine checks. The full suite is `npm run test:engine`; Python tests: `npm run test:python`." };
}

// ---------------------------------------------------------------------------
// app
// ---------------------------------------------------------------------------

async function startServer() {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  const ALLOW_FRAMING = process.env.AEGIS_ALLOW_FRAMING === "1";
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (!ALLOW_FRAMING) res.setHeader("X-Frame-Options", "DENY");
    next();
  });

  // ---------------- health / config
  app.get("/api/health", (_req, res) => {
    const reg = svc.modelRegistry();
    res.json({
      status: "healthy",
      service: "AEGIS Oil-Spill Intelligence",
      version: VERSION,
      mode: state.appMode,
      environment: IS_PROD ? "production" : "development",
      available_scenes: svc.listScenes().length,
      data_root: dataRootStatus(),
      data_inventory: svc.dataInventory(),
      model: reg?.models?.find((m: any) => m.role === "production-baseline")?.name ?? null,
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/api/config/credentials-status", (_req, res) => {
    const vars = ["COPERNICUS_CLIENT_ID", "COPERNICUS_CLIENT_SECRET", "COPERNICUS_MARINE_USERNAME", "COPERNICUS_MARINE_PASSWORD", "CDS_API_KEY"];
    const configured = vars.filter((v) => !!process.env[v]);
    res.json({
      valid: true,
      mode: state.appMode,
      live_ingestion_implemented: false,
      configured,
      missing: vars.filter((v) => !process.env[v]),
      message: "The web server analyses bundled data only; live Copernicus/CDS ingestion is done offline with the scripts in scripts/. Credentials are never sent to the browser.",
    });
  });

  app.post("/api/config/mode", (req, res) => {
    state.appMode = String(req.body?.mode || "REAL").toUpperCase() === "DEMO" ? "DEMO" : "REAL";
    res.json({ mode: state.appMode });
  });

  app.get("/api/model/registry", (_req, res) => {
    const reg = svc.modelRegistry();
    if (!reg) return res.status(404).json({ error: "ml/model_registry.json not found" });
    res.json(reg);
  });

  app.get("/api/selftest", (_req, res) => res.json(selfTest()));

  // ---------------- scenes
  app.get("/api/scenes", (_req, res) => res.json({ scenes: svc.listScenes() }));

  app.get("/api/scenes/:scene_id", (req, res) => {
    const s = svc.getScene(req.params.scene_id);
    if (!s) return res.status(404).json({ error: "Scene not found" });
    res.json({ ...s, assets: svc.assets(s.scene_id) });
  });

  app.get("/api/scenes/:scene_id/assets", (req, res) => res.json({ assets: svc.assets(req.params.scene_id) }));

  app.get("/api/scenes/:scene_id/assets/:name", (req, res) => {
    const file = svc.assetPath(req.params.scene_id, req.params.name);
    if (!file) return res.status(404).json({ error: "Asset not found" });
    res.sendFile(file);
  });

  app.get("/api/environment/:scene_id", (req, res) => {
    const scene = svc.getScene(req.params.scene_id);
    if (!scene) return res.status(404).json({ error: "Scene not found" });
    const env = svc.environment(scene.scene_id);
    const t = req.query.time ? Date.parse(String(req.query.time)) : Date.parse(scene.acquisition_time);
    if (!Number.isFinite(t)) return res.status(400).json({ error: "Invalid time" });
    res.json({
      scene_id: scene.scene_id,
      time: new Date(t).toISOString(),
      sources: svc.environmentDescription(scene.scene_id),
      wind_grid: gridVectors(env.wind, t),
      current_grid: gridVectors(env.current, t),
      wind_time_series: nativeTimeSeries(env.wind, scene.center_lat, scene.center_lon),
      current_time_series: nativeTimeSeries(env.current, scene.center_lat, scene.center_lon),
    });
  });

  // ---------------- detection
  app.post("/api/spills/detect", (req, res) => {
    try {
      const rec = svc.detect(String(req.body?.scene_id ?? ""), String(req.body?.polarization ?? "VV"));
      state.spills.set(rec.spill_id, rec);
      res.json(rec);
    } catch (e) {
      res.status(404).json({ error: (e as Error).message });
    }
  });

  app.get("/api/spills/:spill_id", (req, res) => {
    const s = state.spills.get(Number(req.params.spill_id));
    if (!s) return res.status(404).json({ error: "Spill not found" });
    res.json(s);
  });

  // ---------------- drift (BACKWARD or FORWARD)
  app.post("/api/spills/:spill_id/drift", (req, res) => {
    const spillId = Number(req.params.spill_id);
    const spill = state.spills.get(spillId);
    if (!spill) return res.status(404).json({ error: "Spill not found" });
    const b = req.body ?? {};
    const mode = String(b.mode ?? "BACKWARD").toUpperCase() === "FORWARD" ? "FORWARD" : "BACKWARD";
    const hours = num(b.drift_hours, mode === "FORWARD" ? 48 : 12, 0.5, 120);
    const snapshotHours = Array.isArray(b.snapshot_hours)
      ? b.snapshot_hours.map(Number).filter((h: number) => h > 0 && h <= hours)
      : mode === "FORWARD" ? [6, 12, 24, 48].filter((h) => h <= hours) : [];
    if (!acquireJob(res)) return;
    try {
      const result = runDrift(
        { startTimeIso: spill.detection_time, seedRing: spill.geometry.coordinates, seedRings: spill.geometry.parts, seedPoint: spill.geometry.centroid, env: svc.environment(spill.scene_id) },
        {
          mode,
          hours,
          timestepMinutes: num(b.timestep_minutes, 30, 5, 120),
          numParticles: Math.round(num(b.num_particles, 300, 10, 2000)),
          windFactor: num(b.wind_factor, 0.03, 0, 0.1),
          eddyDiffusivity: num(b.eddy_diffusivity, 2.5, 0, 100),
          unknownCurrentSigma: num(b.unknown_current_sigma, 0.1, 0, 1),
          seed: Math.round(num(b.seed, 42, 0, 2 ** 31 - 1)),
          snapshotHours,
        },
      );
      const simId = state.simCounter++;
      const legacy = toLegacyDrift(result, { simulation_id: simId, spill_id: spillId }, envSummary(spill.scene_id, spill), spill.geometry.orientation_deg, !!spill.real_data);
      state.simulations.set(simId, { result, spill_id: spillId, legacy });
      res.json(legacy);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    } finally {
      releaseJob();
    }
  });

  // ---------------- attribution
  app.get("/api/vessels/candidates", (req, res) => {
    const spillId = Number(req.query.spill_id);
    const spill = state.spills.get(spillId);
    if (!spill) return res.status(404).json({ error: "Spill not found" });
    let sim = req.query.simulation_id ? state.simulations.get(Number(req.query.simulation_id)) : undefined;
    if (!sim) sim = [...state.simulations.values()].reverse().find((s) => s.spill_id === spillId && s.result.mode === "BACKWARD");
    if (!sim) return res.status(400).json({ error: "Run a BACKWARD drift simulation for this spill first." });
    if (sim.result.mode !== "BACKWARD") return res.status(400).json({ error: "Attribution needs a BACKWARD simulation (origin corridor)." });
    const ais = svc.ais(spill.scene_id);
    const att = scoreCandidates(
      ais.tracks,
      {
        obsTimeMs: Date.parse(spill.detection_time),
        slickRing: spill.geometry.coordinates,
        slickRings: spill.geometry.parts,
        slickCentroid: spill.geometry.centroid,
        slickAxisDeg: spill.geometry.orientation_deg,
        corridor: sim.result.centroid_path,
        horizonHours: sim.result.hours,
        aisBbox: ais.bbox,
        baseline: svc.baseline(spill.scene_id),
        dataSourceLabel: ais.label,
      },
      weightsFromQuery(req.query),
    );
    res.json(
      toLegacyAttribution(att, { spill_id: spillId, scene_id: spill.scene_id }, envSummary(spill.scene_id, spill), spill.geometry.orientation_deg, {
        source: ais.label,
        records: ais.records,
        synthetic: ais.synthetic,
      }),
    );
  });

  // ---------------- investigations (agentic workflow)
  const buildParams = (body: any) => {
    const p = body?.params ?? body ?? {};
    return defaultParams(String(body?.scene_id ?? p.scene_id ?? ""), {
      backtrack_hours: p.backtrack_hours ?? p.drift_hours,
      forecast_hours: p.forecast_hours,
      num_particles: p.num_particles,
      timestep_minutes: p.timestep_minutes,
      wind_factor: p.wind_factor,
      eddy_diffusivity: p.eddy_diffusivity,
      unknown_current_sigma: p.unknown_current_sigma,
      seed: p.seed,
      weights: p.weights,
    });
  };

  app.post("/api/investigations", (req, res) => {
    const params = buildParams(req.body);
    if (!svc.getScene(params.scene_id)) return res.status(404).json({ error: "Scene not found" });
    if (!acquireJob(res)) return;
    const inv = createInvestigation(params);
    setImmediate(() => {
      executeInvestigation(inv, svc)
        .catch((e) => console.error("[AEGIS] investigation failed:", e))
        .finally(releaseJob);
    });
    res.status(202).json({ investigation_id: inv.id, status: inv.status, stream: `/api/investigations/${inv.id}/stream` });
  });

  app.get("/api/investigations/:id", (req, res) => {
    const inv = getInvestigation(req.params.id);
    if (!inv) return res.status(404).json({ error: "Investigation not found" });
    res.json(investigationView(inv));
  });

  app.get("/api/investigations/:id/stream", (req, res) => {
    const inv = getInvestigation(req.params.id);
    if (!inv) return res.status(404).json({ error: "Investigation not found" });
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    for (const e of inv.events) send("node", e);
    if (inv.status !== "running") {
      send("complete", { status: inv.status });
      return res.end();
    }
    const listener = (e: NodeEvent | { type: "complete" }) => {
      if ("type" in e) {
        send("complete", { status: inv.status });
        inv.listeners.delete(listener);
        res.end();
      } else send("node", e);
    };
    inv.listeners.add(listener);
    // Heartbeat comment keeps proxies from closing an idle stream.
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);
    // NB: must be res "close". Since Node 16, req "close" fires as soon as the
    // request body is consumed (immediately for GET), which would detach the
    // listener after the replay and silently stall the stream.
    res.on("close", () => {
      clearInterval(heartbeat);
      inv.listeners.delete(listener);
    });
  });

  app.post("/api/investigations/:id/rerun", async (req, res) => {
    const inv = getInvestigation(req.params.id);
    if (!inv) return res.status(404).json({ error: "Investigation not found" });
    if (inv.status === "running") return res.status(409).json({ error: "Investigation is still running" });
    const from = String(req.body?.from ?? "evidence_fusion");
    if (req.body?.weights) inv.state.params.weights = normalizeWeights(req.body.weights);
    if (!acquireJob(res)) return;
    try {
      await executeInvestigation(inv, svc, from);
    } finally {
      releaseJob();
    }
    res.json(investigationView(inv));
  });

  // ---------------- counterfactual analysis (analytical scenarios on a finished investigation)
  app.post("/api/investigations/:id/counterfactual", (req, res) => {
    const inv = getInvestigation(req.params.id);
    if (!inv) return res.status(404).json({ error: "Investigation not found" });
    if (inv.status === "running") return res.status(409).json({ error: "Investigation is still running" });
    const kind = String(req.body?.kind ?? "");
    if (kind !== "exclude_vessel" && kind !== "forcing_sensitivity") return res.status(400).json({ error: "kind must be exclude_vessel or forcing_sensitivity" });
    if (!acquireJob(res)) return;
    try {
      const result = kind === "exclude_vessel" ? excludeVessel(inv, svc, String(req.body?.mmsi ?? "")) : forcingSensitivity(inv, svc);
      res.json({ investigation_id: inv.id, created_at: new Date().toISOString(), ...result });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    } finally {
      releaseJob();
    }
  });

  // ---------------- capabilities (honest status of advanced features)
  app.get("/api/capabilities", (_req, res) => res.json(loadCapabilities(ROOT)));

  // ---------------- basemap tiles (CARTO)
  // The CARTO key stays on the SERVER (read from CARTO_API_KEY, else VITE_CARTO_API_KEY in the server's environment/.env)
  // and is attached to the upstream request here. The browser only ever sees /api/basemap/{z}/{x}/{y}.png, so the key is
  // never compiled into the public bundle, shown in the UI, written to logs or included in reports.
  const cartoKey = () => String(process.env.CARTO_API_KEY || process.env.VITE_CARTO_API_KEY || "").trim();
  app.get("/api/config/basemap", (_req, res) =>
    res.json({ mode: cartoKey() ? "proxy" : "public", tiles: cartoKey() ? "/api/basemap/{z}/{x}/{y}.png" : "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", key_configured: !!cartoKey() }),
  );
  app.get("/api/basemap/:z/:x/:y.png", async (req, res) => {
    const key = cartoKey();
    const z = Number(req.params.z), x = Number(req.params.x), y = Number(req.params.y);
    if (!key) return res.status(404).json({ error: "No CARTO key configured; the client uses the public basemap." });
    if (![z, x, y].every((n) => Number.isInteger(n) && n >= 0) || z > 19 || x >= 2 ** z || y >= 2 ** z) return res.status(400).json({ error: "Invalid tile coordinates" });
    try {
      const upstream = await fetch(`https://a.basemaps.cartocdn.com/rastertiles/voyager/${z}/${x}/${y}.png?key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(10000) });
      if (!upstream.ok) return res.status(upstream.status === 404 ? 404 : 502).json({ error: `Basemap upstream returned HTTP ${upstream.status}` }); // never echo the URL (it carries the key)
      res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "image/png");
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.send(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      res.status(502).json({ error: "Basemap upstream unreachable" });
    }
  });

  // ---------------- investigator feedback (active-learning data structure; in-memory only)
  app.post("/api/feedback", (req, res) => {
    const v = validateFeedback(req.body, (id) => !!getInvestigation(id));
    if (!v.ok || !v.record) return res.status(400).json({ error: v.error ?? "invalid feedback" });
    addFeedback(v.record);
    res.status(201).json(v.record);
  });
  app.get("/api/feedback", (_req, res) => res.json({ storage: "in-memory (not persisted)", records: listFeedback() }));

  // ---------------- legacy end-to-end (now backed by the investigation graph)
  app.post("/api/analysis/run", async (req, res) => {
    const params = buildParams(req.body);
    if (!svc.getScene(params.scene_id)) return res.status(404).json({ error: "Scene not found" });
    if (!acquireJob(res)) return;
    const inv = createInvestigation(params);
    try {
      await executeInvestigation(inv, svc);
    } finally {
      releaseJob();
    }
    const s = inv.state;
    const env = envSummaryFromInvestigation(s.environment);
    const analysis = {
      analysis_id: inv.id,
      scene_id: params.scene_id,
      timestamp: new Date().toISOString(),
      status: inv.status === "completed" ? "COMPLETE" : "FAILED",
      app_mode: state.appMode,
      detection: s.detection,
      drift: s.backward && s.detection ? toLegacyDrift(s.backward, { simulation_id: inv.id, spill_id: s.detection.spill_id }, env, s.detection.geometry.orientation_deg, !!s.detection.real_data) : null,
      forecast: s.forward ?? null,
      attribution: s.attribution && s.detection && s.ais
        ? toLegacyAttribution(s.attribution, { spill_id: s.detection.spill_id, scene_id: params.scene_id }, env, s.detection.geometry.orientation_deg, { source: s.ais.source, records: s.ais.records, synthetic: s.ais.synthetic })
        : null,
      investigation: { id: inv.id, events: inv.events, hypotheses: s.hypotheses, uncertainty: s.uncertainty, risk: s.risk, recommendations: s.recommendations },
    };
    state.analyses.set(inv.id, analysis);
    res.json(analysis);
  });

  app.get("/api/analysis/:analysis_id", (req, res) => {
    const a = state.analyses.get(req.params.analysis_id);
    if (!a) return res.status(404).json({ error: "Analysis not found." });
    res.json(a);
  });

  // unknown API routes -> JSON 404 (never the SPA HTML)
  app.use("/api", (_req, res) => res.status(404).json({ error: "Unknown API route" }));

  // ---------------- frontend
  if (IS_PROD) {
    const dist = path.join(ROOT, "dist");
    if (!fs.existsSync(path.join(dist, "index.html"))) {
      console.error(`[AEGIS] ${dist}/index.html not found. Run "npm run build" first.`);
    }
    app.use(express.static(dist, { index: false, maxAge: "1h" }));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
  } else {
    const { createServer } = await import("vite");
    const vite = await createServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  }

  // JSON error handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[AEGIS] request error:", err);
    res.status(500).json({ error: "Internal server error", ...(IS_PROD ? {} : { detail: err.message }) });
  });

  const server = app.listen(PORT, HOST, () => {
    const inv = svc.dataInventory();
    console.log("");
    console.log("==============================================");
    console.log(` AEGIS Oil-Spill Intelligence v${VERSION}`);
    console.log("==============================================");
    console.log(` Server : http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}  (${IS_PROD ? "production" : "development"})`);
    for (const d of inv) console.log(` ${d.present ? "[x]" : "[ ]"} ${d.file}`);
    console.log("==============================================");
  });
  const shutdown = (signal: string) => {
    console.log(`[AEGIS] ${signal} received: closing server`);
    server.close(() => process.exit(0));
    const forceExit = setTimeout(() => process.exit(0), 5000); // open SSE streams must not block shutdown
    (forceExit as any).unref?.();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

startServer().catch((error) => {
  console.error("Fatal server error:", error);
  process.exit(1);
});
