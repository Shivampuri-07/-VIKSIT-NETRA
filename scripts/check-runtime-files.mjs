/**
 * Verifies that every file the production UI/server needs is present.
 *   node scripts/check-runtime-files.mjs           # data + model registry
 *   node scripts/check-runtime-files.mjs --build   # + built frontend and server bundle
 * Exit 1 if anything REQUIRED is missing (used by the Dockerfile to fail the build).
 */
import fs from "fs";
import path from "path";

const root = process.cwd();
const withBuild = process.argv.includes("--build");
const exists = (p) => fs.existsSync(path.join(root, p));
const required = [];
const optional = [];
const req = (p, role) => required.push({ p, role, ok: exists(p) });
const opt = (p, role) => optional.push({ p, role, ok: exists(p) });

req("ml/model_registry.json", "model registry (health, diagnostics, report)");
req("data/sample/scenes_catalog.json", "synthetic demo scene catalogue");
if (exists("data/sample/scenes_catalog.json")) {
  for (const s of JSON.parse(fs.readFileSync(path.join(root, "data/sample/scenes_catalog.json"), "utf8"))) {
    req(`data/sample/${s.scene_id}_ais.json`, `synthetic AIS for demo scene ${s.scene_id}`);
  }
}
req("data/ais/2018/ais_2018-09-26_scene.csv", "real-scene AIS (MarineCadastre)");
req("data/ais/2018/trajectory_attribution_2018-09-26.csv", "2018 offline attribution baseline");
req("data/era5/era5_2018-09-26_field.json", "real-scene ERA5 wind field");
req("data/sentinel1/derived/manifest.json", "SAR report images manifest");
if (exists("data/sentinel1/derived/manifest.json")) {
  for (const a of JSON.parse(fs.readFileSync(path.join(root, "data/sentinel1/derived/manifest.json"), "utf8"))) {
    req(`data/sentinel1/derived/${a.file}`, `SAR image: ${a.name}`);
  }
}
req("ml/extensions/capabilities.json", "capability registry (/api/capabilities)");
opt("data/era5/era5_2018-09-26.nc", "ERA5 source NetCDF (provenance; listed in /api/health)");
opt("ml/checkpoints/unet_oil_spill_best.pth", "U-Net baseline (listed in /api/health; not loaded by the web server)");
opt("ml/results/inference/2018_09_26/unet_geometry_scene.json", "U-Net MODEL_PREDICTION polygons of the real scene (else the scene reports NOT_AVAILABLE; the reference label is never used as a detection)");
opt("ml/results/inference/2018_09_26/reference_label_geometry.json", "REFERENCE_LABEL polygons (evaluation overlay only)");
opt("data/currents/GOM_S1A_20180926_REAL_currents.json", "historical ocean-current field (else CURRENT_DATA_UNAVAILABLE / NOT_ASSESSED)");

let leaked = [];
if (withBuild) {
  req("dist/index.html", "built frontend");
  req("dist-server/server.cjs", "built server bundle");
  if (exists("dist")) {
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    leaked = walk(path.join(root, "dist")).filter((f) => /server\.c?js(\.map)?$|\.env/.test(path.basename(f))).map((f) => path.relative(root, f));
  }
}

for (const r of required) console.log(`${r.ok ? "[ok]     " : "[MISSING]"} ${r.p}  - ${r.role}`);
for (const r of optional) console.log(`${r.ok ? "[ok]     " : "[absent] "} ${r.p}  - optional: ${r.role}`);
for (const l of leaked) console.log(`[EXPOSED] ${l} must not be inside the public dist/ directory`);
const missing = required.filter((r) => !r.ok).length;
console.log(`\n${required.length - missing}/${required.length} required files present; ${optional.filter((o) => o.ok).length}/${optional.length} optional.`);
process.exit(missing || leaked.length ? 1 : 0);
