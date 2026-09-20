/**
 * SAR image upload -> existing frozen U-Net -> detection result.
 *
 * The web server does not contain the model: it runs the EXISTING offline inference code
 * (ml/inference/predict_upload.py) in a child process, which loads the frozen checkpoint read-only.
 * Nothing is retrained and no result is fabricated here; this module only moves bytes and parses JSON.
 *
 * If the Python runtime (python3 + torch + rasterio) is not available - for example in a slim container -
 * the endpoint reports MODEL_RUNTIME_UNAVAILABLE instead of pretending to have a prediction.
 */

import { spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

export interface UploadRecord {
  id: string;
  scene_id: string;
  filename: string;
  bytes: number;
  created_utc: string;
  /** Observation time supplied by the analyst; falls back to the upload time (and says so). */
  observed_at: string;
  observed_at_supplied: boolean;
  dir: string;
  result: any;
}

const MAX_BYTES = Number(process.env.AEGIS_MAX_UPLOAD_BYTES || 300 * 1024 * 1024);
const PYTHON = process.env.AEGIS_PYTHON || "python3";
const TIMEOUT_MS = Number(process.env.AEGIS_UPLOAD_TIMEOUT_MS || 10 * 60 * 1000);
const UPLOAD_ROOT = process.env.AEGIS_UPLOAD_DIR || path.join(os.tmpdir(), "viksit-netra-uploads");

const store = new Map<string, UploadRecord>();
const MAX_KEPT = 12;

export const uploadLimits = { maxBytes: MAX_BYTES, python: PYTHON, dir: UPLOAD_ROOT };

export function getUpload(id: string): UploadRecord | undefined {
  return store.get(id);
}

export function listUploads(): UploadRecord[] {
  return [...store.values()].sort((a, b) => b.created_utc.localeCompare(a.created_utc));
}

/** Only the characters that can appear in a scene id / path segment. */
function safeId(): string {
  return crypto.randomBytes(6).toString("hex");
}

function safeName(name: string): string {
  const base = path.basename(String(name || "upload")).replace(/[^\w.\- ]/g, "_");
  return base.slice(0, 120) || "upload";
}

function remember(rec: UploadRecord) {
  store.set(rec.id, rec);
  // keep the working set small: drop the oldest uploads and their files
  const all = listUploads();
  for (const old of all.slice(MAX_KEPT)) {
    store.delete(old.id);
    fs.rm(old.dir, { recursive: true, force: true }, () => undefined);
  }
}

function runPython(projectRoot: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(PYTHON, args, { cwd: projectRoot, env: process.env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }, TIMEOUT_MS);
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}\n${(e as Error).message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * Store the uploaded bytes and run the frozen model over them.
 * Resolves with the prediction record, or with a labelled failure - never with an invented result.
 */
export interface UploadOutcome {
  ok: boolean;
  /** HTTP status to use when ok === false */
  status?: number;
  /** error payload when ok === false */
  body?: any;
  record?: UploadRecord;
}

export async function analyseUpload(
  projectRoot: string,
  bytes: Buffer,
  filename: string,
  observedAt?: string | null,
): Promise<UploadOutcome> {
  if (!bytes?.length) return { ok: false, status: 400, body: { ok: false, reason: "EMPTY_UPLOAD", detail: "No file content was received." } };
  if (bytes.length > MAX_BYTES) {
    return {
      ok: false,
      status: 413,
      body: { ok: false, reason: "INPUT_TOO_LARGE", detail: `File is ${(bytes.length / 1e6).toFixed(1)} MB; this server accepts up to ${(MAX_BYTES / 1e6).toFixed(0)} MB.` },
    };
  }

  const id = safeId();
  const name = safeName(filename);
  const dir = path.join(UPLOAD_ROOT, id);
  fs.mkdirSync(dir, { recursive: true });
  const inputPath = path.join(dir, "input" + (path.extname(name) || ".tif"));
  fs.writeFileSync(inputPath, bytes);

  const script = path.join(projectRoot, "ml", "inference", "predict_upload.py");
  if (!fs.existsSync(script)) {
    return { ok: false, status: 500, body: { ok: false, reason: "MODEL_RUNTIME_UNAVAILABLE", detail: "The inference script is not present in this deployment." } };
  }

  const { code, stdout, stderr } = await runPython(projectRoot, [script, "--input", inputPath, "--out-dir", dir, "--original-name", name]);

  let result: any = null;
  const line = stdout.trim().split("\n").filter(Boolean).pop();
  if (line) {
    try { result = JSON.parse(line); } catch { /* fall through */ }
  }
  if (!result) {
    fs.rm(dir, { recursive: true, force: true }, () => undefined);
    const missingRuntime = /ModuleNotFoundError|No module named|ENOENT|not found/i.test(stderr) || code === null;
    return {
      ok: false,
      status: missingRuntime ? 503 : 500,
      body: {
        ok: false,
        reason: missingRuntime ? "MODEL_RUNTIME_UNAVAILABLE" : "INFERENCE_FAILED",
        detail: missingRuntime
          ? `The model runtime (python3 with torch and rasterio) is not available to this server, so the upload could not be scored. Set AEGIS_PYTHON to a suitable interpreter.`
          : "The inference process did not return a result.",
        stderr: stderr.split("\n").slice(-6).join("\n").slice(0, 800),
      },
    };
  }

  if (!result.ok) {
    fs.rm(dir, { recursive: true, force: true }, () => undefined);
    return { ok: false, status: 415, body: result };          // rejected input: an honest, expected outcome
  }

  const supplied = !!(observedAt && Number.isFinite(Date.parse(observedAt)));
  const rec: UploadRecord = {
    id,
    scene_id: `UPLOAD_${id}`,
    filename: name,
    bytes: bytes.length,
    created_utc: new Date().toISOString(),
    observed_at: supplied ? new Date(Date.parse(observedAt!)).toISOString() : new Date().toISOString(),
    observed_at_supplied: supplied,
    dir,
    result,
  };
  remember(rec);
  return { ok: true, record: rec };
}

/**
 * One-off check that the model runtime (python + torch + rasterio) can actually be reached.
 * Cached; used by /api/health so an operator can see whether uploads will work in this deployment.
 */
let runtimeProbe: Promise<{ available: boolean; detail: string }> | null = null;
export function probeModelRuntime(): Promise<{ available: boolean; detail: string }> {
  if (runtimeProbe) return runtimeProbe;
  runtimeProbe = new Promise((resolve) => {
    const child = spawn(PYTHON, ["-c", "import torch, rasterio, numpy, PIL; print(torch.__version__, rasterio.__version__)"], { env: process.env });
    let out = "";
    let err = "";
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, 60_000);
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("error", (e) => { clearTimeout(timer); resolve({ available: false, detail: `${PYTHON} could not be started: ${(e as Error).message}` }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0
        ? { available: true, detail: `${PYTHON}: torch/rasterio ${out.trim()}` }
        : { available: false, detail: `${PYTHON} is present but the model packages are missing: ${err.split("\n")[0] || `exit ${code}`}` });
    });
  });
  return runtimeProbe;
}

/** Absolute path of a generated preview image, or null. */
export function previewPath(id: string, which: "preview" | "overlay"): string | null {
  const rec = store.get(id);
  if (!rec) return null;
  const p = path.join(rec.dir, `${which}.png`);
  return fs.existsSync(p) ? p : null;
}

// ---------------------------------------------------------------------------
// Live inference on a raster that is already on disk (the bundled demo scene).
//
// This is the "prove it" path: the SAME frozen checkpoint and the SAME script used for uploads are
// run, in this process's deployment, against the real Sentinel-1 raster that produced the stored
// MODEL_PREDICTION polygons. The stored polygons stay untouched; the live run is reported next to
// them so the two can be compared. Nothing here can invent a result: if the model runtime is absent
// the caller gets MODEL_RUNTIME_UNAVAILABLE, exactly as an upload would.
// ---------------------------------------------------------------------------

export interface LiveSceneRun {
  ok: boolean;
  status?: number;
  body?: any;
  result?: any;
}

/** Cached per raster path: a full-scene CPU run costs ~30 s, so it is computed once per process. */
const liveSceneCache = new Map<string, Promise<LiveSceneRun>>();

export function liveSceneRunCached(projectRoot: string, rasterPath: string, label: string): Promise<LiveSceneRun> {
  const key = rasterPath;
  const hit = liveSceneCache.get(key);
  if (hit) return hit;
  const run = analyseLocalRaster(projectRoot, rasterPath, label).then((out) => {
    // a transient failure must not be cached forever
    if (!out.ok && out.body?.reason === "INFERENCE_FAILED") liveSceneCache.delete(key);
    return out;
  });
  liveSceneCache.set(key, run);
  return run;
}

/** Run the frozen U-Net over a raster already present on disk. Never mutates the raster. */
export async function analyseLocalRaster(projectRoot: string, rasterPath: string, label: string): Promise<LiveSceneRun> {
  if (!fs.existsSync(rasterPath)) {
    return {
      ok: false,
      status: 404,
      body: {
        ok: false,
        reason: "SCENE_RASTER_UNAVAILABLE",
        detail: `The SAR raster for ${label} is not present in this deployment, so live inference cannot be run here.`,
      },
    };
  }
  const script = path.join(projectRoot, "ml", "inference", "predict_upload.py");
  if (!fs.existsSync(script)) {
    return { ok: false, status: 500, body: { ok: false, reason: "MODEL_RUNTIME_UNAVAILABLE", detail: "The inference script is not present in this deployment." } };
  }

  const dir = path.join(UPLOAD_ROOT, "live", safeName(label));
  fs.mkdirSync(dir, { recursive: true });

  const started = Date.now();
  const { code, stdout, stderr } = await runPython(projectRoot, [script, "--input", rasterPath, "--out-dir", dir, "--original-name", path.basename(rasterPath)]);

  let result: any = null;
  const line = stdout.trim().split("\n").filter(Boolean).pop();
  if (line) {
    try { result = JSON.parse(line); } catch { /* fall through */ }
  }
  if (!result) {
    const missingRuntime = /ModuleNotFoundError|No module named|ENOENT|not found/i.test(stderr) || code === null;
    return {
      ok: false,
      status: missingRuntime ? 503 : 500,
      body: {
        ok: false,
        reason: missingRuntime ? "MODEL_RUNTIME_UNAVAILABLE" : "INFERENCE_FAILED",
        detail: missingRuntime
          ? "The model runtime (python3 with torch and rasterio) is not available to this deployment, so the model cannot be run live here. The stored MODEL_PREDICTION polygons remain the only detection shown."
          : "The inference process did not return a result.",
        stderr: stderr.split("\n").slice(-6).join("\n").slice(0, 800),
      },
    };
  }
  if (!result.ok) return { ok: false, status: 415, body: result };

  return { ok: true, result: { ...result, wall_clock_seconds: Math.round((Date.now() - started) / 100) / 10, output_dir_is_temporary: true } };
}

/** Directory holding the previews of the cached live run for a label, or null. */
export function liveScenePreviewPath(label: string, which: "preview" | "overlay"): string | null {
  const p = path.join(UPLOAD_ROOT, "live", safeName(label), `${which}.png`);
  return fs.existsSync(p) ? p : null;
}
