/**
 * Browser entry point for the incident PDF.
 *
 * Builds the report from the CURRENT investigation state held by the UI (the
 * same object the dashboard renders), the viewer's selected forecast horizon
 * and selected vessel, renders it with the dependency-free PDF writer and
 * triggers a normal browser download (Blob + <a download>). No server-side
 * PDF is involved. Optional inputs (SAR images, model registry, data
 * inventory) are fetched with timeouts; if any fails the report is still
 * produced and says what is missing.
 */

import type { InvestigationView, Scene } from "../types";
import { buildReportModel, ReportImage } from "./reportModel";
import { renderReport } from "./renderReport";

export interface GenerateOptions {
  investigation: InvestigationView;
  scene: Scene | null;
  selectedVesselMmsi: string | null;
  forecastHorizon: number | "ALL";
  counterfactuals?: any[];
}

export interface GenerateResult {
  ok: boolean;
  message: string;
  filename?: string;
  bytes?: number;
  pages?: number;
}

/** Report images requested from the scene asset API, in display order. */
const REPORT_ASSETS = ["overlay_slick_crop", "unet_mask_crop"];

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function fetchJson(url: string, ms = 8000): Promise<any | null> {
  try {
    const r = await fetchWithTimeout(url, ms);
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/** Fetches an image and re-encodes it as a (downscaled) JPEG for embedding. */
async function loadAsJpeg(url: string, maxPx = 1400): Promise<{ bytes: Uint8Array | null; error?: string }> {
  let blob: Blob;
  try {
    const r = await fetchWithTimeout(url, 10000);
    if (!r.ok) return { bytes: null, error: `HTTP ${r.status}` };
    blob = await r.blob();
  } catch (e) {
    return { bytes: null, error: (e as Error).name === "AbortError" ? "timed out" : (e as Error).message };
  }
  try {
    const bmp = await createImageBitmap(blob);
    const k = Math.min(1, maxPx / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bmp.width * k));
    canvas.height = Math.max(1, Math.round(bmp.height * k));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const jpeg: Blob | null = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.85));
    if (!jpeg) throw new Error("JPEG encoding failed");
    return { bytes: new Uint8Array(await jpeg.arrayBuffer()) };
  } catch (e) {
    // no canvas support: raw JPEGs can still be embedded directly
    if (blob.type === "image/jpeg") return { bytes: new Uint8Array(await blob.arrayBuffer()) };
    return { bytes: null, error: `could not decode image (${(e as Error).message})` };
  }
}

function triggerDownload(bytes: Uint8Array, filename: string) {
  // copy into a plain ArrayBuffer (valid BlobPart on every TS/DOM lib version)
  const buf = new ArrayBuffer(bytes.length);
  new Uint8Array(buf).set(bytes);
  const blob = new Blob([buf], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export async function generateIncidentReport(o: GenerateOptions): Promise<GenerateResult> {
  try {
    if (!o.investigation) return { ok: false, message: "No investigation to report on." };
    if (o.investigation.status === "running") return { ok: false, message: "Investigation still running; wait for it to finish." };
    const sceneId = o.investigation.state.scene?.scene_id ?? o.investigation.state.params?.scene_id ?? o.scene?.scene_id ?? "";

    const [assetList, registry, health] = await Promise.all([
      sceneId ? fetchJson(`/api/scenes/${encodeURIComponent(sceneId)}/assets`) : Promise.resolve(null),
      fetchJson("/api/model/registry"),
      fetchJson("/api/health"),
    ]);
    const assets: any[] = Array.isArray(assetList?.assets) ? assetList.assets : [];
    const images: ReportImage[] = [];
    for (const name of REPORT_ASSETS) {
      const a = assets.find((x) => x.name === name);
      if (!a) continue;
      const r = await loadAsJpeg(`/api/scenes/${encodeURIComponent(sceneId)}/assets/${encodeURIComponent(name)}`);
      images.push({ name, caption: `${a.description}${a.georeferenced ? "" : " Not georeferenced."}`, bytes: r.bytes, error: r.error });
    }
    if (!assetList && sceneId && !o.investigation.state.detection?.synthetic) {
      images.push({ name: "scene assets", caption: "", bytes: null, error: "asset list could not be loaded" });
    }

    const model = buildReportModel({
      investigation: o.investigation,
      scene: o.scene,
      selectedVesselMmsi: o.selectedVesselMmsi,
      forecastHorizon: o.forecastHorizon,
      counterfactuals: o.counterfactuals ?? [],
      images,
      registry,
      dataInventory: Array.isArray(health?.data_inventory) ? health.data_inventory : null,
    });
    const { bytes, pages } = renderReport(model);
    const stamp = model.generatedAt.replace(/[-:]/g, "").slice(0, 13);
    const filename = `AEGIS_${model.incidentId}_${stamp}Z.pdf`.replace(/[^A-Za-z0-9_.-]+/g, "_");
    triggerDownload(bytes, filename);
    const failedImgs = images.filter((i) => !i.bytes).length;
    return {
      ok: true,
      filename,
      bytes: bytes.length,
      pages,
      message: `Report downloaded: ${filename} (${pages} pages, ${Math.round(bytes.length / 1024)} KB)${failedImgs ? `; ${failedImgs} image(s) unavailable, noted in the report` : ""}.`,
    };
  } catch (e) {
    console.error("[AEGIS] report generation failed", e);
    return { ok: false, message: `Report generation failed: ${(e as Error).message}` };
  }
}
