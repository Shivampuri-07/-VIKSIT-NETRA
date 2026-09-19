# AEGIS Sentinel — FINAL STATUS

Date of the runs below: 2026-09-19. Everything here was measured or verified in this project on that date; anything that is
a fallback, a limitation or not done is stated as such. **Decision-support research prototype: no output is proof that a
vessel caused a spill.**

## 1. What was implemented

| Area | Change |
|---|---|
| External data root | `AEGIS_DATA_ROOT` (env or local `.env`) resolved by `ml/data_root.py` and `server/lib/dataroot.ts`. Large data is read from the external folder, never copied or moved. No user name is hard-coded. `/api/health` reports `data_root` without printing the path. |
| Real U-Net inference | `ml/inference/run_unet_scene.py`: frozen checkpoint → tiled inference on the real georeferenced 2018-09-26 scene (EPSG:32616, 10 m) → probability raster → threshold 0.5 → geospatial polygons (EPSG:4326). Checkpoint is only read (SHA-256 checked before and after). |
| Provenance labels | `MODEL_PREDICTION` (drives the investigation), `REFERENCE_LABEL` (evaluation only; optional map overlay, never a detection, never used by drift/attribution/hypotheses), `DERIVED_GEOMETRY` (area/axis computed from the prediction). The hand-drawn 14-vertex outline was removed. If no prediction exists the scene reports `NOT_AVAILABLE`; the reference label is **not** substituted. |
| Baseline first | `ml/evaluation/run_eval.py` (Dice, IoU, precision, recall, pixel FPR, false-alarm scenes, ECE/Brier, leakage checks; three protocols). Stored historical metrics are retained; fresh results reproduce them exactly. |
| 6-epoch experiment | Pre-registered protocol run in its own directory; evaluated with the identical code; decided by `ml/evaluation/compare_candidate.py` (never promotes). |
| Environment | Real 2018 hourly surface current (HYCOM analysis) added; land/no-data cells are `null`, never filled (`LAND_OR_NO_DATA`). Wind is still the 2-hour ERA5 field (see §7). |
| Drift | Multi-polygon slicks seeded/scored; per-horizon `forcing_support` (a horizon is "supported" only if wind **and** current samples are ≥ 50 % REAL); `currentScale` what-if parameter for sensitivity cases. |
| Attribution / hypotheses | H1 strength is capped by contradicting evidence; "N vessels rated HIGH" is recorded as contradicting evidence; the labelled reference mask is no longer used as evidence. |
| LangGraph | Real `@langchain/langgraph` StateGraph is the default orchestrator (`AEGIS_ORCHESTRATOR=auto`). See §6. |
| Explainability | Exclude-vessel re-ranking, forcing sensitivity (with real-current what-if cases), exact Shapley contributions kept; the candidate panel explains heuristic score vs mathematical contribution vs (non-existent) learned probability vs unverified investigator feedback. |
| Report | Adds model-run provenance, MEASURED vs STORED_HISTORICAL metrics, reference-label note, per-horizon forcing support and "persistence scenarios, not forecasts", orchestrator status, NOT ASSESSED list; new provenance colours (model prediction, derived geometry, reference label, land/no data). |
| UI | Collapsible side panels, layer controls with hints, collapsible legend, fit-to-spill/origin/forecast/all-evidence, forecast timeline (step/play; ⚠ on unsupported horizons), focus-map mode, phone-width layout scrolls. See §8. |
| CARTO | Key stays on the server (tile proxy). See §9. |
| Tests | 2 new Python test modules (data root / dataset cache / metrics fast path, promotion rule), new and rewritten TS tests (real LangGraph, fallback, forcing sensitivity with and without a current, report without a current), guard tests tightened, fixture fixed. See §3. |

## 2. Data sources actually connected

| Source | Status |
|---|---|
| Real SAR scene `Data/sentinel1/real/2018_09_26.tif` | REAL, read from `AEGIS_DATA_ROOT`. Byte-identical to the held-out test image (same SHA-256). float32, EPSG:32616, 10 m, dB-like values. |
| Labelled `Radar_data` (14 train + 7 test scenes with masks, train/val CSVs) | REAL, read from `AEGIS_DATA_ROOT` (used by evaluation and training). Verified: 14/14 and 7/7 image/mask pairs, EPSG:32616, float32. |
| ERA5 10 m wind | REAL but only **2 hourly fields** (14:00 and 15:00 UTC), 0.25° grid. No CDS credentials are available, so the window could **not** be extended. |
| Ocean current | **HYCOM + NCODA GOMl0.04/expt_32.5 hourly surface analysis** (a data-assimilative *model analysis*, not observations, not Copernicus Marine), 2018-09-26T03:00Z → 2018-09-28T15:00Z, 13 × 20 lattice (0.08°), 13 land nodes stored as `null`. Fetched with `scripts/fetch_hycom_currents.py` (no credentials). Raw-response SHA-256 recorded in the file. |
| AIS | NOAA/USCG Nationwide AIS via MarineCadastre, 2018-09-26 (terrestrial receivers), 13,104 reports, 87 MMSI, spatially clipped to the SAR footprint. |
| Vessel metadata | Only the AIS static fields (name/IMO/type/length missing for some vessels). No registry. |
| Look-alike / non-oil data | None. Only a low-wind flag exists (the wind at the slick is 2.2–2.6 m/s, so the flag is ON for this scene). |

## 3. Tests

| Command | Result |
|---|---|
| `node -v` | v22.23.2 |
| `npm run lint` (tsc) | passed |
| `npm run test:ts` (engine + report + agents) | **51 / 51 passed**, 0 failed, 0 skipped |
| `npm run test:python:core` | **65 run, OK, 1 skipped** (the "training without torch refuses" test is skipped because torch is installed) |
| `npm run build` | passed (main JS chunk 968 kB — size warning only) |
| `npm run verify:build` | 15/15 required files, 5/5 optional |
| `npm run verify:baseline` | passed: 18 artifact hashes, checkpoint structure (110 tensors, 4,322,241 params), NumPy reproduction max \|diff\| 7.45e-08 (run earlier in the session) |
| Production smoke test | server started from `dist-server/server.cjs`: `/api/health` healthy (REAL mode, 12/12 data files), UI 200, tile proxy 200, full investigation completed with `LANGGRAPH`, counterfactuals worked |
| `npm run test:python` (legacy FastAPI backend test) | **NOT RUN**: fails at import, `pyproj` is not installed. The backend is optional and unused by the UI. |
| Real-scene screenshots | captured with headless Chrome (dashboard, focus map, focus map + drawer, phone width) and inspected |

Test changes (no test deleted): the "no fabricated 0.892 / 0.805" guard now allows those digits only where they equal a
score actually computed in the investigation state (a real score coincidentally equals 0.892); orchestrator, forcing
sensitivity and drift tests were updated for a real current and real LangGraph (the no-current and fallback branches keep
their own tests); the training-guard fixture now writes valid temporary GeoTIFFs (production code untouched).

## 4. Frozen baseline (measured, unchanged checkpoint)

Checkpoint `ml/checkpoints/unet_oil_spill_best.pth`, SHA-256
`33688d9b6148f792ec9900f881b6241468c0915080808bd3f5458259edde24af` — verified unchanged at the end of every evaluation.
Threshold 0.5, 7 held-out scenes (`ml/results/eval_baseline.json`).

| Protocol | Macro Dice | IoU | Precision | Recall | Pixel FPR | Pooled Dice |
|---|---|---|---|---|---|---|
| **historic** (stored protocol; reproduces stored numbers exactly, max \|diff\| 0.0) | 0.4650 | 0.3469 | 0.4598 | 0.5939 | 0.0354 | 0.4636 |
| **scene_overlap** (whole-scene z-score, 32 px overlap, full coverage; *decision protocol*) | 0.4588 | 0.3393 | 0.4401 | 0.5953 | 0.0356 | 0.4731 |
| **patch_overlap** (per-patch z-score = training normalisation) | 0.4692 | 0.3239 | 0.6491 | 0.4294 | 0.0103 | 0.3662 |

Calibration (scene_overlap): ECE 0.0389, Brier 0.0390. False-alarm scenes: 0.
Per-scene Dice varies enormously (0.002 – 0.84 under scene_overlap). **The result depends strongly on the normalisation:**
for the real 2018-09-26 scene the Dice is 0.843 with whole-scene normalisation but only 0.193 with the per-patch
normalisation the model was trained with. Both are recorded. The app uses the whole-scene variant because it is the model
registry's registered evaluation protocol; `AEGIS_UNET_VARIANT=patch` switches to the other.

On the real 2018-09-26 scene (measured by `run_unet_scene.py`): 534,549 predicted pixels in 9 polygons (52 connected
components), Dice 0.8434, IoU 0.7292, precision 0.757, recall 0.952, pixel FPR 0.0103 against the reference label.

### Leakage checks (`ml/results/eval_baseline.json`)
* **Train / validation: LEAKY.** All 14 source scenes appear in both the train CSV (21,744 rows) and the validation CSV
  (7,249 rows). Validation Dice (stored 0.684; candidate 0.571) is optimistic and is **not** an independent estimate.
* **Train / test:** no shared files. But test-scene footprints overlap training-scene footprints in the same region on
  other dates (≥ 12 days apart), and some labelled test-slick pixels coincide with train-labelled slick pixels
  (recurrent slick sites). Test results are independent acquisitions, **not** independent regions.

## 5. Six-epoch candidate (evaluated, NOT promoted)

Protocol `ml/experiments/six_epoch_protocol.json` run as written: 6 epochs, seed 42, whole-scene normalisation,
random rot90/flip augmentation, early-stopping patience 2, same CSV split as the baseline. Directory
`ml/checkpoints/candidates/20260919T132055Z_six_epoch_experiment/` (config, per-epoch metrics, summary, checkpoint).
Duration 12,796 s (all 6 epochs ran; early stopping did not trigger). Best epoch 6, best (leaky) validation Dice 0.5709.
Note the candidate differs from the baseline in more than epoch count (normalisation, augmentation, early stopping), as
pre-registered.

Held-out evaluation, identical code and protocol as the baseline (`ml/results/eval_candidate_six_epoch.json`):

| scene_overlap protocol | Baseline | Candidate |
|---|---|---|
| Macro Dice / IoU / precision / recall | 0.4588 / 0.3393 / 0.4401 / 0.5953 | **0.5520** / 0.4247 / 0.5428 / 0.7641 |
| Pooled Dice | **0.4731** | 0.4249 |
| Pixel FPR (macro / pooled) | **0.0356** / 0.0415 | 0.0970 / 0.0615 |
| ECE / Brier | **0.0389 / 0.0390** | 0.0928 / 0.0905 |
| False-alarm scenes | 0 | 0 |
| Scenes with higher Dice | — | 6 of 7 (2018_09_26: 0.843 → 0.908) |

**Promotion decision (pre-registered rule: pooled AND macro Dice must improve, false-alarm scenes must not rise,
calibration must not be worse): KEEP_BASELINE.** Failed criteria: pooled Dice, ECE, Brier. `promoted: false`
(`ml/results/comparison_candidate_vs_baseline.json`). The candidate detects more oil but also over-predicts and is
worse calibrated. With 7 scenes and a per-scene Dice spread of about 0.3, differences are descriptive; no significance is
claimed and the candidate is **not** claimed to be better. The production checkpoint was never modified.

## 6. LangGraph status

**Real LangGraph runs.** `@langchain/langgraph` 1.4.16 + `@langchain/core` 1.2.11 (added to `package.json`/lock). By
default (`AEGIS_ORCHESTRATOR=auto`) all 12 AEGIS nodes execute inside a LangGraph `StateGraph`; the investigation view
reports `orchestrator_status: "LANGGRAPH"` and `graph_node_invocations: 12`. Verified by a test (results identical to the
fallback, event order identical) and by a run through the bundled production server. If the package cannot load, the run
is labelled `DETERMINISTIC_FALLBACK` (tested with a simulated missing module; `AEGIS_ORCHESTRATOR=deterministic` forces it).
Honest scope: the nodes are **rule-based computations — no language model is used anywhere**, nothing is AI-generated.
Your suggested stage names are shown per node (Scene Intake + SAR Evidence → Environment Evidence → Drift Physics → AIS
Evidence → Attribution Reasoning → Report); the 12 existing nodes were kept, and **Counterfactual Checks run on demand**
(UI/API), not as an automatic graph node.

## 7. 2018-09-26 environment status

* **Current: REAL historical product connected** (HYCOM analysis above; model analysis, not observations). 95.8 % of
  backtrack samples and 100 % of forecast samples are REAL (the rest is the half hour before the product's first sample,
  held constant and labelled PERSISTED). No arbitrary demo current is used anywhere for this scene. If the file is absent
  the scene reports `CURRENT_DATA_UNAVAILABLE / NOT_ASSESSED` and only a zero-mean uncertainty prior is applied.
* **Wind: only 2 ERA5 hours.** Real wind covers 3.3 % of the 12 h backtrack window and 1.3 % of the 48 h forecast
  window; the rest is held constant and labelled PERSISTED. Consequently **all four forecast horizons (T+6/12/24/48 h)
  are flagged NOT SUPPORTED BY FORCING** and are presented as persistence scenarios, not forecasts. Extending ERA5 needs
  CDS credentials (not available here).
* Conventions verified by tests: u eastward / v northward in m/s, wind direction "from" vs "to", leeway 3 % with deflection
  to the right in the northern hemisphere, RK2 integration, diffusion √(2Kdt), ERA5 nearest-cell values equal the values
  recorded from the NetCDF. Wave height, SST and coastal exposure are NOT ASSESSED.

## 8. UI and focus map

Dashboard: collapsible left ("Spill & Environment") and right ("Candidate Vessels") panels (state remembered), tabbed dock
(Agents / Analytics / Hypotheses·Uncertainty·Risk / Counterfactuals), status chips, tooltips, `aria` labels, phone-width
layout scrolls. **Nothing was removed** (SAR frame, spill, backtrack, origin zone, forecast, wind, current, AIS tracks,
candidates, evidence, analytics, hypotheses, agent workflow, uncertainty, provenance, report download, scene controls,
metrics/status all remain). Map: layer toggles with hints, collapsible legend, fit-to-spill / origin / forecast / all
evidence, scene fit, normal +/− zoom, hover/click details, forecast timeline (previous / play / next, horizon buttons
with ⚠ for unsupported horizons).
**Focus map:** the same map instance is enlarged to a full-screen workspace (it is not remounted, so scene, layers,
horizon, selection and zoom are preserved). Info panels collapse into four drawers on the right (Scene & run, Spill &
env, Candidates, Analysis); `Esc` closes a drawer, then exits focus. Deep links: `/?focus=1`, `/?focus=1&drawer=candidates`.
Verified with real screenshots only; there is no automated browser test suite.

## 9. CARTO key

The key is in the local, git-ignored `.env` (`VITE_CARTO_API_KEY`); `.env.example` keeps it empty. The client no longer
reads `import.meta.env.VITE_CARTO_API_KEY` (Vite would have inlined it into the public bundle). The server reads it
(`CARTO_API_KEY`, else `VITE_CARTO_API_KEY`) and proxies tiles at `/api/basemap/{z}/{x}/{y}.png`; errors never echo the
upstream URL. Verified: a proxied tile returns 200 image/png, `/api/config/basemap` does not contain the key, and the
value is **not present** anywhere in `dist/` or `dist-server/`. Upstream also returns 200 for this style without a key.

## 10. Limitations (read before relying on anything)

1. The evaluation is on 7 scenes with a very large between-scene spread; all comparisons are descriptive.
2. Validation is leaky (§4); test scenes overlap training footprints on other dates.
3. Model output depends strongly on the normalisation choice (§4); no calibrated per-pixel confidence exists.
4. Wind covers 2 hours only; every forecast horizon is an unsupported persistence scenario.
5. The current is a model analysis (HYCOM), not observations, on a coarse lattice (0.08°), for one event only.
6. AIS is terrestrial-only, spatially clipped to the SAR footprint, with incomplete vessel metadata; 8 vessels are rated
   HIGH priority and the top two scores are essentially tied (gap 0.000–0.002 between runs) — the evidence does not single out a vessel. All candidates are
   `causality_status: NOT CONFIRMED`. Attribution weights/thresholds are heuristics with no calibration data.
7. No SAR look-alike classifier exists (only a low-wind flag; it is ON for this scene). Weathering, beaching, waves and
   Stokes drift are not modelled; coastal exposure is not assessed.
8. Acquisition time (14:23:49Z) is the value recorded by the earlier offline analysis; the raster carries no time tag.
9. Other model extension points (ensemble, self-supervised encoder, learned drift, AIS sequence model, GNN, multimodal
   fusion, probabilistic attribution) are **not implemented** — see `ml/extensions/capabilities.json`.
10. `npm run test:python` (legacy backend) was not run (`pyproj` missing). No automated browser tests. `npm audit` shows 3
    moderate findings; `npm audit fix` was deliberately not run.
11. Performance-only edits to `ml/datasets/dataset.py` (scene cache) and `ml/metrics/evaluation.py` (NumPy fast path) were
    verified bit-identical / exactly equal by tests; no training or data-pipeline semantics changed.
12. The local `.env` had `APP_MODE=DEMO`; that one line was set to `REAL` (a UI label only). `AEGIS_DATA_ROOT` was appended.

## 11. Exact data-root configuration and run commands

```bash
cd ~/Desktop/AEGIS-Sentinel-Oil-Spill-CLOUD-FINAL
# .env (git-ignored) must contain:  AEGIS_DATA_ROOT="/path/to/AEGIS-Sentinel-Oil-Spill-main 3"   (already appended here)
# or export it for the shell:
export AEGIS_DATA_ROOT="$HOME/Desktop/AEGIS-Sentinel-Oil-Spill-main 3"

nvm use 22 && npm ci
npm run lint && npm run test:ts && npm run test:python:core && npm run build && npm run verify:build
APP_MODE=REAL npm start                 # production, http://localhost:3000   (or: npm run dev)
curl -s localhost:3000/api/health | head -c 300

# real-data workflow (all read-only w.r.t. the frozen checkpoint)
python3 ml/evaluation/run_eval.py --label baseline
python3 ml/inference/run_unet_scene.py --normalization scene
python3 scripts/fetch_hycom_currents.py
python3 ml/training/train.py --dry-run
python3 ml/training/train.py --epochs 6 --run-name six_epoch_experiment --normalization scene --early-stopping-patience 2 --augment --seed 42
python3 ml/evaluation/run_eval.py --checkpoint ml/checkpoints/candidates/<run>/candidate_best.pth --label candidate_six_epoch
python3 ml/evaluation/compare_candidate.py --candidate ml/results/eval_candidate_six_epoch.json
python3 scripts/package_release.py      # release ZIP + SHA-256
```
Orchestrator: `AEGIS_ORCHESTRATOR=auto|langgraph|deterministic`. Basemap key: `CARTO_API_KEY` (server-side).

## 12. Frozen checkpoint

`ml/checkpoints/unet_oil_spill_best.pth` SHA-256 `33688d9b6148f792ec9900f881b6241468c0915080808bd3f5458259edde24af`,
size 17,329,363 bytes — unchanged (checked before and after every evaluation, inference and training run). No original
dataset was moved, copied or deleted.
