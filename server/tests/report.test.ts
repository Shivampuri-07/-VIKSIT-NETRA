/**
 * Incident-report verification. Generates ACTUAL PDF files from real engine
 * investigation states and inspects the bytes:
 *   - structure: header, EOF, every xref offset points at its object; qpdf --check
 *   - text: pdftotext -raw (poppler) when installed, else a built-in
 *     content-stream extractor
 *   - colours: status chips are parsed from the content streams (rectangle
 *     fill immediately followed by its label) so colour semantics are measured
 *   - layout: pdftotext -bbox word boxes must stay inside page/body margins
 *
 * Run: npm run test:report     PDFs are written to $AEGIS_REPORT_TEST_DIR (default /tmp/aegis_report_tests)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { SceneService, REAL_SCENE_ID } from "../lib/scenes";
import { createInvestigation, defaultParams, executeInvestigation, investigationView } from "../lib/investigation";
import { excludeVessel, forcingSensitivity } from "../lib/counterfactual";
import { buildReportModel, ReportInput, ReportImage } from "../../src/report/reportModel";
import { renderReport } from "../../src/report/renderReport";
import { fmt, fmtLatLon } from "../../src/lib/format";
import { wrapText, measureText } from "../../src/report/pdfWriter";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = process.env.AEGIS_REPORT_TEST_DIR || "/tmp/aegis_report_tests";
fs.mkdirSync(OUT, { recursive: true });
const svc = new SceneService(ROOT);
const has = (cmd: string) => spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;
const POPPLER = has("pdftotext") && has("pdfinfo");
const QPDF = has("qpdf");

// ---------------------------------------------------------------- helpers
async function runView(sceneId: string, params: any = {}) {
  const inv = createInvestigation(defaultParams(sceneId, { num_particles: 300, ...params }));
  await executeInvestigation(inv, svc);
  // JSON round-trip == exactly what the browser receives from GET /api/investigations/:id
  return JSON.parse(JSON.stringify(investigationView(inv)));
}

function decodeLiteral(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "\\") { out += s[i]; continue; }
    const n = s[i + 1];
    if (/[0-7]/.test(n)) { out += String.fromCharCode(parseInt(s.substr(i + 1, 3), 8)); i += 3; }
    else { out += n; i += 1; }
  }
  return out;
}

interface Parsed { ops: string[]; runs: string[]; chips: { label: string; fill: number[]; size: number; outline: number[] | null }[] }
function parseContent(bytes: Uint8Array): Parsed {
  const raw = Buffer.from(bytes).toString("latin1");
  const ops: string[] = [];
  const re = /<< \/Length (\d+) >>\nstream\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) ops.push(...raw.substr(m.index + m[0].length, Number(m[1])).split("\n"));
  const runs: string[] = [];
  const chips: { label: string; fill: number[]; size: number; outline: number[] | null }[] = [];
  const tj = /\((.*)\) Tj/;
  ops.forEach((line, i) => {
    const t = line.match(tj);
    if (!t) return;
    const txt = decodeLiteral(t[1]);
    runs.push(txt);
    const prev = ops[i - 1] ?? "";
    const to255 = (xs: string[]) => xs.map((x) => Math.round(Number(x) * 255));
    const r = prev.match(/^q ([\d.]+) ([\d.]+) ([\d.]+) rg [\d.]+ [\d.]+ [\d.]+ ([\d.]+) re f Q$/);
    const o = prev.match(/^q ([\d.]+) ([\d.]+) ([\d.]+) rg ([\d.]+) ([\d.]+) ([\d.]+) RG [\d.]+ w \[\] 0 d [\d.]+ [\d.]+ [\d.]+ ([\d.]+) re B Q$/);
    const tf = line.match(/\/F2 ([\d.]+) Tf/);
    if (r && tf && Math.abs(Number(r[4]) - 11.055) < 0.05) {
      chips.push({ label: txt, fill: to255([r[1], r[2], r[3]]), size: Number(tf[1]), outline: null });
    } else if (o && tf && Math.abs(Number(o[7]) - 11.055) < 0.05) {
      chips.push({ label: txt, fill: to255([o[1], o[2], o[3]]), size: Number(tf[1]), outline: to255([o[4], o[5], o[6]]) });
    }
  });
  return { ops, runs, chips };
}

function checkStructure(bytes: Uint8Array) {
  const raw = Buffer.from(bytes).toString("latin1");
  assert.ok(raw.startsWith("%PDF-1.4\n"), "PDF header");
  assert.ok(raw.trimEnd().endsWith("%%EOF"), "EOF marker");
  const sx = Number(raw.match(/startxref\n(\d+)\n%%EOF/)![1]);
  assert.ok(raw.substr(sx, 4) === "xref", "startxref points at xref");
  const entries = [...raw.substr(sx).matchAll(/^(\d{10}) 00000 n $/gm)].map((x) => Number(x[1]));
  entries.forEach((off, i) => assert.ok(raw.substr(off, `${i + 1} 0 obj`.length) === `${i + 1} 0 obj`, `xref entry ${i + 1}`));
}

interface Rendered { file: string; bytes: Uint8Array; pages: number; text: string; flat: string; parsed: Parsed }
function render(name: string, input: ReportInput): Rendered {
  const model = buildReportModel({ generatedAt: new Date("2026-09-19T10:00:00Z"), ...input });
  const { bytes, pages } = renderReport(model);
  const file = path.join(OUT, `${name}.pdf`);
  fs.writeFileSync(file, bytes);
  checkStructure(bytes);
  if (QPDF) {
    const q = spawnSync("qpdf", ["--check", file], { encoding: "utf8" });
    assert.equal(q.status, 0, `qpdf --check ${name}: ${q.stdout}${q.stderr}`);
  }
  const parsed = parseContent(bytes);
  let text: string;
  if (POPPLER) {
    const info = spawnSync("pdfinfo", [file], { encoding: "utf8" }).stdout;
    assert.equal(Number(info.match(/Pages:\s+(\d+)/)![1]), pages, "pdfinfo page count");
    text = spawnSync("pdftotext", ["-raw", "-enc", "UTF-8", file, "-"], { encoding: "utf8", maxBuffer: 64e6 }).stdout;
  } else text = parsed.runs.join("\n");
  return { file, bytes, pages, text, flat: text.replace(/\s+/g, " "), parsed };
}

function realImages(): ReportImage[] {
  const f = path.join(ROOT, "data", "sentinel1", "derived", "2018_09_26_overlay_slick_crop.jpg");
  return [{ name: "overlay_slick_crop", caption: "SAR backscatter with U-Net predicted oil (red). Not georeferenced.", bytes: new Uint8Array(fs.readFileSync(f)) }];
}

const LEGEND_PT = 5.8; // legend chips on page 1 show every category by design
const chipFills = (p: Parsed, label: string) => p.chips.filter((c) => c.label === label && c.size !== LEGEND_PT).map((c) => c.fill.join(","));
const legendFills = (p: Parsed) => Object.fromEntries(p.chips.filter((c) => c.size === LEGEND_PT).map((c) => [c.label, c.fill.join(",")]));
const GREEN = "26,127,55", GREY = "110,119,129", PURPLE = "130,80,223", AMBER = "212,167,44", INDIGO = "62,84,160";

// ---------------------------------------------------------------- tests
test("REAL incident: PDF is valid and contains every required section with values from the state", async () => {
  const view = await runView(REAL_SCENE_ID);
  const s = view.state;
  const r = render("real_incident", { investigation: view, images: realImages(), registry: svc.modelRegistry(), dataInventory: svc.dataInventory() });
  assert.ok(r.bytes.length > 50_000, `non-trivial size (${r.bytes.length} B)`);
  assert.ok(r.pages >= 8, `pages ${r.pages}`);
  const t = r.flat;
  const must: [string, string][] = [
    ["incident id", s.report.incident_id],
    ["investigation id", view.investigation_id],
    ["SAR section", "Satellite detection and SAR evidence"],
    ["satellite", "Sentinel-1A"],
    ["spill area (from state)", `${fmt(s.detection.geometry.area_km2, 3)} km2`],
    ["spill centroid (from state)", fmtLatLon(s.detection.geometry.centroid, 5)],
    ["polygon vertices", `Polygon vertices (${s.detection.geometry.coordinates.length}`],
    ["wind row", "Wind speed / direction at T0"],
    ["wind value (from state)", `${fmt(s.environment.at_observation.wind_speed_ms)} m/s`],
    ["current row", "Ocean surface current (uo, vo)"],
    ["provenance of forcing", "Provenance of forcing samples used by the drift engine"],
    ["backtrack section", "Backtracked origin (backward Lagrangian ensemble)"],
    ["backtrack P90 (from state)", `P90 radius ${fmt(s.backward.final.r90_km)} km`],
    ["forecast section", "Forward forecast and Future Impact Zone"],
    ["impact zone", "Future Impact Zone at each horizon"],
    ["map", "Situation map"],
    ["AIS table", `All ${s.attribution.candidates.length} scored vessels`],
    ["vessel evidence", "Why this vessel is a priority candidate"],
    ["ranking weights", "Weights used"],
    ["uncertainty", "Uncertainty (reported separately from scores)"],
    ["hypotheses", "Competing hypotheses"],
    ["risk", "Risk assessment"],
    ["recommendations", "Recommended response"],
    ["timeline", "Investigation timeline (agent graph execution)"],
    ["data sources", "Data sources and provenance"],
    ["AIS file", "data/ais/2018/ais_2018-09-26_scene.csv"],
    ["limitations", "Scientific limitations and warnings"],
    ["scientific disclaimer (from state)", "No output of this system constitutes proof"],
    ["non-legal disclaimer", "PROBABILISTIC INVESTIGATIVE EVIDENCE, NOT LEGAL PROOF"],
  ];
  const missing = must.filter(([, v]) => !t.includes(v));
  assert.deepEqual(missing, [], `missing: ${JSON.stringify(missing)}`);
  for (const sn of s.forward.snapshots) {
    assert.ok(t.includes(`T+${sn.hours}h`), `forecast row T+${sn.hours}h`);
    assert.ok(t.includes(`${fmt(sn.hull_area_km2, 1)} km2`), `envelope area T+${sn.hours}h from state`);
  }
  for (const h of ["H1", "H2", "H3", "H4"]) assert.ok(t.includes(h), h);
  for (const c of s.attribution.candidates) assert.ok(t.includes(c.mmsi), `candidate ${c.mmsi} listed`);
  for (const e of s.hypotheses) assert.ok(t.includes(e.title), e.title);
  for (const rec of s.recommendations) assert.ok(t.includes(rec.action.slice(0, 30)), `recommendation: ${rec.action.slice(0, 30)}`);
  for (const lbl of ["Scene & SAR Detection Agent", "Environmental Forcing Agent", "Backtracking Agent", "Forward Drift Forecast Agent", "AIS Candidate Retrieval Agent", "Vessel Attribution & Evidence Agent", "Final Evidence & Report Agent"]) assert.ok(t.includes(lbl), `timeline ${lbl}`);
  assert.ok(t.includes(`${view.events.length} node events recorded`), "event count from state");
  const footers = (r.text.match(/Vessel attribution is probabilistic investigative evidence, NOT legal proof\./g) ?? []).length;
  assert.equal(footers, r.pages, "non-legal disclaimer in the footer of every page");
  if (POPPLER) {
    const imgs = spawnSync("pdfimages", ["-list", r.file], { encoding: "utf8" }).stdout.trim().split("\n").slice(2);
    assert.equal(imgs.length, 1, "SAR image embedded");
  }
});

test("REAL incident: no fabricated metrics; real current is shown WITH its provenance; outline is MODEL_PREDICTION", async () => {
  const view = await runView(REAL_SCENE_ID);
  const r = render("real_current_check", { investigation: view, images: realImages() });
  // The old server hard-coded 0.892 / 0.805 / 89.2 %. Those digits may only appear if they equal a composite score that
  // was actually COMPUTED in this investigation's state (a real score can coincide with an old constant).
  const computedScores = new Set<string>((view.state.attribution?.candidates ?? []).map((c: any) => Number(c.composite_score).toFixed(3)));
  const computedPct = new Set<string>([...computedScores].map((x) => (Number(x) * 100).toFixed(1)));
  const suspicious = (r.flat.match(/\b0\.892\b|\b0\.805\b|89\.2 ?%/g) ?? []).filter((h: string) => {
    const num = h.replace(/ ?%$/, "");
    return !(computedScores.has(num) || computedPct.has(num));
  });
  assert.deepEqual(suspicious, [], "old fabricated 0.892 / 0.805 absent (unless they equal a computed composite score)");
  assert.ok(r.flat.includes("0.465") && r.flat.includes("0.848"), "stored historical registry metrics present (with provenance)");
  assert.ok(r.flat.includes("MEASURED_THIS_RUN") && r.flat.includes("STORED_HISTORICAL"), "measured and stored metrics both retained, each labelled");
  assert.match(r.flat, /Ocean surface current \(uo, vo\) REAL/, "env table: current chip REAL (a real historical product is connected)");
  assert.match(r.flat, /Ocean current at T0 REAL/, "summary: current REAL");
  assert.ok(!r.flat.includes("Ocean current: NOT AVAILABLE"), "no 'current not available' warning when a product is connected");
  assert.ok(r.flat.includes("HYCOM"), "current product source is named");
  // orchestrator status, forecast support and NOT ASSESSED fields are part of the report
  assert.match(r.flat, /ORCHESTRATOR = (LANGGRAPH|DETERMINISTIC_FALLBACK)/, "orchestrator status stated");
  assert.ok(r.flat.includes("no language model produced any value"), "no-LLM statement present");
  assert.ok(r.flat.includes("Persistence scenarios, not forecasts"), "unsupported horizons are labelled scenarios");
  assert.ok(r.flat.includes("NOT SUPPORTED by forcing coverage"), "per-horizon support reason present");
  assert.ok(r.flat.includes("NOT ASSESSED") && /Wave height, sea-surface temperature/.test(r.flat), "NOT ASSESSED fields listed");
  assert.ok(r.flat.includes("NOT CONFIRMED") || r.flat.includes("NOT LEGAL PROOF"), "non-causation wording present");
  assert.ok(r.flat.includes("not observations") || r.flat.includes("MODEL analysis") || r.flat.includes("MODEL"), "the current is described as a model analysis, not an observation");
  // integrity: summary must not let "Wind at T0: REAL" imply the drift ran on real wind
  const bw = view.state.backward.forcing.wind_status_fractions;
  assert.ok(r.flat.includes(`Over the drift windows only ${Math.round(bw.REAL * 100)} % (backtrack)`), "wind T0 note quantifies REAL share over drift windows");
  assert.match(r.flat, /Drift forcing provenance PERSISTED wind samples: backtrack PERSISTED \d+ %/, "summary forcing row with dominant PERSISTED chip");
  // provenance of the outline: model prediction (indigo); the reference label is a separate evaluation-only row (amber)
  assert.ok(chipFills(r.parsed, "MODEL PREDICTION").length >= 1 && chipFills(r.parsed, "MODEL PREDICTION").every((f) => f === INDIGO), "model prediction chips are indigo");
  assert.ok(chipFills(r.parsed, "REFERENCE LABEL").length >= 1 && chipFills(r.parsed, "REFERENCE LABEL").every((f) => f === AMBER), "reference label chips amber");
  assert.ok(chipFills(r.parsed, "REAL").length >= 2 && chipFills(r.parsed, "REAL").every((f) => f === GREEN), "REAL chips are green");
  assert.ok(chipFills(r.parsed, "PERSISTED").every((f) => f === AMBER), "PERSISTED chips amber");
  assert.equal(chipFills(r.parsed, "FALLBACK/DEMO").length, 0, "no demo chips in the real report (legend excluded)");
  const lg = legendFills(r.parsed);
  assert.deepEqual([lg["REAL"], lg["MODEL PREDICTION"], lg["PERSISTED"], lg["REFERENCE LABEL"], lg["FALLBACK/DEMO"], lg["NOT AVAILABLE"]], [GREEN, INDIGO, AMBER, AMBER, PURPLE, GREY], "legend provenance colours");
});

test("REAL incident WITHOUT a current product: current is NOT presented as real (no invented value)", async () => {
  class NoCurrentService extends SceneService {
    environment(id: string) { const e = super.environment(id); return { ...e, current: { kind: "none" as const, label: "CURRENT_DATA_UNAVAILABLE (test)" } }; }
  }
  const nc = new NoCurrentService(ROOT);
  const inv = createInvestigation(defaultParams(REAL_SCENE_ID, { num_particles: 300 }));
  await executeInvestigation(inv, nc);
  const view = JSON.parse(JSON.stringify(investigationView(inv)));
  const r = render("real_no_current_check", { investigation: view, images: realImages() });
  assert.match(r.flat, /Ocean surface current \(uo, vo\) NOT AVAILABLE not available/, "env table: current chip NOT AVAILABLE + value not available");
  assert.match(r.flat, /Ocean current at T0 NOT AVAILABLE not available/, "summary: current not available");
  assert.ok(!/v = -?[\d.]+ m\/s; [\d.]+ m\/s toward/.test(r.flat), "no current vector value printed");
  assert.ok(r.flat.includes("Ocean current: NOT AVAILABLE"), "current warning callout");
  assert.ok(r.flat.includes("it is an uncertainty model, not an observation"), "current prior described as uncertainty");
  assert.ok(chipFills(r.parsed, "NOT AVAILABLE").length >= 3);
  assert.ok(chipFills(r.parsed, "NOT AVAILABLE").every((f) => f === GREY), "NOT AVAILABLE chips are grey");
});

test("colour coding separates evidence, risk, uncertainty, warnings and unavailable data", async () => {
  const view = await runView(REAL_SCENE_ID);
  const s = view.state;
  const r = render("real_colours", { investigation: view, images: realImages() });
  const all = r.parsed.chips;
  const blue = new Set(["9,105,218", "84,174,255", "182,227,255", "234,238,242"]);
  const slate = new Set(["216,222,228", "140,149,159", "66,74,83"]);
  const risk = { LOW: GREEN, MODERATE: AMBER, HIGH: "219,109,40", SEVERE: "207,34,46" } as Record<string, string>;
  const ev = all.filter((c) => c.label.startsWith("EVIDENCE "));
  assert.equal(ev.length, 4, "4 hypothesis evidence chips");
  s.hypotheses.forEach((h: any, i: number) => {
    const c = ev[i];
    if (h.uncertainty === "HIGH") assert.ok(c.outline && blue.has(c.outline.join(",")) && c.fill.join(",") === "255,255,255", `${h.id}: HIGH uncertainty -> outlined evidence chip`);
    else assert.ok(!c.outline && blue.has(c.fill.join(",")), `${h.id}: solid blue evidence chip`);
  });
  const scoreChips = all.filter((c) => c.label.startsWith("SCORE "));
  assert.ok(scoreChips.length >= 5 && scoreChips.every((c) => c.outline && c.fill.join(",") === "255,255,255"), "dossier score chips outlined under HIGH attribution uncertainty");
  assert.ok(all.some((c) => c.label === `RISK ${s.risk.level}` && c.fill.join(",") === risk[s.risk.level]), "summary risk chip");
  assert.ok(all.some((c) => c.label === `UNCERTAINTY ${s.uncertainty.overall}` && slate.has(c.fill.join(","))), "summary uncertainty chip");
  const unc = all.filter((c) => c.label.startsWith("UNCERTAINTY "));
  assert.ok(unc.length >= 5 && unc.every((c) => !c.outline && slate.has(c.fill.join(","))), "uncertainty chips on the slate scale (never hedged)");
  const riskChip = all.find((c) => c.label === s.risk.level && c.fill.join(",") === risk[s.risk.level]);
  assert.ok(riskChip, `risk chip ${s.risk.level} uses risk palette`);
  assert.ok(chipFills(r.parsed, "IMMEDIATE").every((f) => f === risk.SEVERE), "IMMEDIATE action = red");
  // same label, different dimension -> different palette: "HIGH" uncertainty (slate) vs "HIGH" urgency (orange)
  const high = new Set(chipFills(r.parsed, "HIGH"));
  assert.ok(high.has("66,74,83") && high.has("219,109,40"), `HIGH rendered per dimension: ${[...high]}`);
  // warnings: amber callout background; unavailable: grey callout background
  assert.ok(r.parsed.ops.some((o) => o.includes("1 0.973 0.773 rg")), "amber warning callout drawn");
  assert.ok(r.parsed.ops.some((o) => o.includes("0.965 0.973 0.98 rg") && o.includes("0.549 0.584 0.624 RG")), "grey unavailable callout drawn");
  // italic grey "not available" text for missing values (sea temperature / waves)
  assert.ok(r.parsed.ops.some((o) => o.includes("/F3") && o.includes("(not available) Tj") && o.startsWith("q 0.341 0.376 0.416 rg")), "unavailable values in grey italic");
  // HIGH attribution uncertainty => score bars hollow (stroked), never solid
  const unc2 = s.uncertainty.components.find((c: any) => c.component === "Vessel attribution").level;
  const barH = "7.37"; // 2.6 mm in points
  const solid = r.parsed.ops.filter((o) => /rg [\d.]+ [\d.]+ [\d.]+ 7\.37\d* re f Q$/.test(o) && !o.startsWith("q 0.918 0.933 0.949 rg")).length;
  const hollow = r.parsed.ops.filter((o) => /RG [\d.]+ w \[\] 0 d [\d.]+ [\d.]+ [\d.]+ 7\.37\d* re S Q$/.test(o)).length;
  // hypothesis balance bars follow EACH hypothesis's uncertainty; candidate score bars follow attribution uncertainty
  const hypSolid = s.hypotheses.filter((h: any) => h.uncertainty !== "HIGH" && (h.evidence_balance ?? 0) > 0).length;
  const hypHollow = s.hypotheses.filter((h: any) => h.uncertainty === "HIGH" && (h.evidence_balance ?? 0) > 0).length;
  const candBars = s.attribution.candidates.filter((c: any) => c.composite_score > 0).length;
  const dossierBars = s.attribution.candidates.slice(0, 5).reduce((n: number, c: any) => n + [c.feature_breakdown.spatial_proximity_score, c.feature_breakdown.temporal_alignment_score, c.feature_breakdown.trajectory_intersection_score, c.feature_breakdown.kinematic_consistency_score].filter((v: number) => v > 0).length, 0);
  assert.equal(unc2, "HIGH", "this real incident has HIGH attribution uncertainty (gap < 0.05)");
  assert.equal(solid, hypSolid, `solid bars = non-HIGH-uncertainty hypotheses only (${solid} vs ${hypSolid}) (${barH})`);
  assert.equal(hollow, candBars + dossierBars + hypHollow, `hollow bars = all candidate/dossier score bars + HIGH-uncertainty hypotheses (${hollow})`);
});

test("SYNTHETIC demo incident is labelled on every page and never shown as real", async () => {
  const demo = svc.listScenes().find((x) => x.synthetic)!;
  const view = await runView(demo.scene_id);
  const r = render("demo_incident", { investigation: view, images: [] });
  const strips = (r.text.match(/SYNTHETIC DEMO DATA - NOT A REAL EVENT/g) ?? []).length;
  assert.equal(strips, r.pages, "synthetic banner on every page");
  assert.ok(r.flat.includes("SYNTHETIC DEMO SCENE"), "synthetic callout");
  assert.ok(r.flat.includes("[SYNTHETIC]"), "vessels marked [SYNTHETIC]");
  assert.ok(r.flat.includes("Synthetic demo scene: there is no SAR image."), "no SAR image claimed");
  assert.equal(chipFills(r.parsed, "REAL").length, 0, "no REAL chip anywhere in a demo report (legend excluded)");
  assert.equal(chipFills(r.parsed, "REAL-DERIVED").length, 0, "no REAL-DERIVED chip in a demo report");
  assert.ok(chipFills(r.parsed, "FALLBACK/DEMO").length >= 4 && chipFills(r.parsed, "FALLBACK/DEMO").every((f) => f === PURPLE), "demo chips purple");
  assert.ok(!r.flat.includes("MarineCadastre"), "demo AIS not attributed to MarineCadastre");
});

test("state-derived: selected horizon, selected vessel and mutated values appear; nothing is hard-coded", async () => {
  const view = await runView(REAL_SCENE_ID);
  const cands = view.state.attribution.candidates;
  const sel = cands[6];
  const r = render("real_selected_T24", { investigation: view, forecastHorizon: 24, selectedVesselMmsi: sel.mmsi });
  assert.ok(r.flat.includes("forecast horizon T+24 h"), "viewer horizon recorded");
  assert.ok(r.flat.includes("Highlighted row: horizon selected in the viewer (T+24 h)"));
  assert.ok(r.flat.includes("T+24 h with its particle cloud"), "map shows selected horizon");
  assert.ok(r.flat.includes(`selected vessel ${sel.vessel_name} (MMSI ${sel.mmsi})`), "selected vessel recorded");
  assert.ok(r.flat.includes(`#${sel.rank} ${sel.vessel_name} (MMSI ${sel.mmsi}) SCORE`) && r.flat.includes("SELECTED IN VIEWER"), "rank-7 vessel gets a dossier");
  // mutate the state: the report must follow it
  const mut = JSON.parse(JSON.stringify(view));
  mut.state.detection.geometry.area_km2 = 12.345;
  mut.state.backward.final.r90_km = 7.777;
  mut.state.attribution.candidates[0].vessel_name = "TEST VESSEL MUTATED";
  const m = render("mutated_state", { investigation: mut });
  assert.ok(m.flat.includes("12.345 km2") && !m.flat.includes("54.177 km2"), "area follows state");
  assert.ok(m.flat.includes("P90 radius 7.78 km"), "origin P90 follows state");
  assert.ok(m.flat.includes("TEST VESSEL MUTATED"), "candidate follows state");
  // different weights -> different ranking table
  const inv2 = await runView(REAL_SCENE_ID, { weights: { spatial: 1, temporal: 0, trajectory: 0, consistency: 0 } });
  const w = render("real_spatial_weights", { investigation: inv2 });
  assert.ok(w.flat.includes("spatial 1.00, temporal 0.00, corridor 0.00, kinematic 0.00"), "weights from state");
});

test("missing optional data: failed investigation, stripped state, failed/corrupt images all render", async () => {
  // 1) failed investigation (no scene, no detection)
  const failed = await runView("NO_SUCH_SCENE");
  const f = render("missing_failed_investigation", { investigation: failed, images: [] });
  assert.ok(f.pages >= 2);
  for (const x of ["Sections without data in this investigation", "Detection not available", "Situation map not available", "Candidate ranking not available", "FAILED"]) assert.ok(f.flat.includes(x), x);
  // 2) real state with optional parts removed + failed image + corrupt image + no registry/inventory
  const view = await runView(REAL_SCENE_ID);
  for (const k of ["forward", "attribution", "hypotheses", "risk", "uncertainty", "recommendations", "environment"]) delete view.state[k];
  const imgs: ReportImage[] = [
    { name: "overlay_slick_crop", caption: "x", bytes: null, error: "HTTP 404" },
    { name: "unet_mask_crop", caption: "corrupt bytes", bytes: new Uint8Array([1, 2, 3, 4, 5]) },
  ];
  const p = render("missing_partial_state", { investigation: view, images: imgs, registry: null, dataInventory: null });
  for (const x of ["Forecast not available", "Candidate ranking not available", "Hypotheses not available", "Risk not available", "Environmental analysis not available", 'Image "overlay_slick_crop" unavailable: HTTP 404', "image could not be decoded"]) assert.ok(p.flat.includes(x), x);
});

test("wrapText breaks long paths at separators, never beyond the column", () => {
  const lines = wrapText("File data/cmems/GOM_S1A_20180926_REAL_currents.json", 30, "regular", 7.2);
  assert.ok(lines.length >= 2 && lines.every((l) => measureText(l, "regular", 7.2) <= 30 + 1e-9), JSON.stringify(lines));
  assert.ok(lines.slice(0, -1).every((l) => /[\/_.\-]$/.test(l) || !l.includes("/")), `breaks after separators: ${JSON.stringify(lines)}`);
  assert.equal(lines.join("").replace(/ /g, ""), "Filedata/cmems/GOM_S1A_20180926_REAL_currents.json", "no characters lost");
});

test("long vessel list + very long strings: paginated, header repeated, nothing outside the page", async () => {
  const view = await runView(REAL_SCENE_ID);
  const base = view.state.attribution.candidates;
  // TEST FIXTURE ONLY: 5x the real list with altered MMSIs, plus pathological strings
  const many = [];
  for (let k = 0; k < 5; k++) for (const c of base) many.push({ ...JSON.parse(JSON.stringify(c)), mmsi: `9${k}${c.mmsi}`.slice(0, 12), rank: many.length + 1 });
  many[0].vessel_name = "AN EXTREMELY LONG VESSEL NAME ".repeat(8) + "Δt → ≥ σ — ⚠";
  many[0].why_priority = ["Wordwithoutanyspacesthatisfarlongerthananycolumnwidthcouldeverpossiblyholdwithoutbreaking".repeat(3), ...many[0].why_priority];
  view.state.attribution.candidates = many;
  const r = render("long_vessel_list", { investigation: view });
  for (const c of many) assert.ok(r.flat.includes(c.mmsi), `row ${c.mmsi}`);
  const headers = (r.text.match(/Rank rng/g) ?? []).length;
  assert.ok(headers >= 8, `table header repeated across pages (${headers})`);
  assert.ok(r.flat.includes("delta t -> >= sigma"), "unicode transliterated, not garbled");
  if (POPPLER) {
    const html = spawnSync("pdftotext", ["-bbox", "-enc", "UTF-8", r.file, "-"], { encoding: "utf8", maxBuffer: 64e6 }).stdout;
    const words = [...html.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">/g)].map((w) => w.slice(1).map(Number));
    assert.ok(words.length > 1000);
    const mm = 72 / 25.4;
    const outside = words.filter(([x0, y0, x1, y1]) => x0 < 14 * mm - 1 || x1 > 196 * mm + 1 || y1 > 297 * mm);
    assert.equal(outside.length, 0, `words outside the side margins/page: ${outside.length}`);
    const inFooterGap = words.filter(([, y0, , y1]) => y1 > 280 * mm && y0 < 285 * mm);
    assert.equal(inFooterGap.length, 0, `body text overflowing into the footer zone: ${inFooterGap.length}`);
  }
});

test("counterfactual results and exact Shapley contributions appear in the PDF (only for the same investigation)", async () => {
  const inv = createInvestigation(defaultParams(REAL_SCENE_ID, { num_particles: 150 }));
  await executeInvestigation(inv, svc);
  const view = JSON.parse(JSON.stringify(investigationView(inv)));
  const top = inv.state.attribution!.candidates[0];
  const cfs = [{ ...excludeVessel(inv, svc, top.mmsi), investigation_id: inv.id }, { ...forcingSensitivity(inv, svc), investigation_id: inv.id },
               { ...excludeVessel(inv, svc, top.mmsi), investigation_id: "INV-OTHER" }];
  const r = render("real_with_counterfactuals", { investigation: view, counterfactuals: cfs });
  assert.ok(r.flat.includes("Counterfactual analyses (analytical scenarios)"));
  assert.ok(r.flat.includes("ANALYTICAL SCENARIOS"));
  assert.ok(r.flat.includes(`How would the ranking and hypotheses change if ${top.vessel_name}`));
  assert.ok(r.flat.includes("How sensitive is the origin estimate"));
  assert.equal((r.flat.match(/How would the ranking and hypotheses change/g) ?? []).length, 1, "results of another investigation are not reported");
  assert.ok(r.flat.includes("Exact Shapley contributions"));
  const none = render("real_without_counterfactuals", { investigation: view });
  assert.ok(!none.flat.includes("Counterfactual analyses"));
});
