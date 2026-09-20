# AEGIS deployment and verification

**Architecture:** one Node service (`server.ts`, Express) serves the built React UI (`dist/`) and the API.
The server bundle is built to `dist-server/` (never publicly served). The legacy FastAPI backend
(`backend/`, `Dockerfile.api`) is optional; the UI does not call it.

## Local (macOS)
```bash
nvm install 22 && nvm use 22          # Node 22 LTS (.nvmrc)
npm ci                                # exact versions from package-lock.json
npm run lint                          # TypeScript type-check
npm run test:ts                       # engine + report + agents tests
npm run build                         # vite build -> dist/, server -> dist-server/server.cjs
npm run verify:build                  # required runtime files present, no server code in dist/
npm start                             # production mode, http://localhost:3000
curl -s localhost:3000/api/health | head -c 300
```
Development with hot reload: `npm run dev`.

### External data root (large original data is never copied into this repository)
The labelled `Radar_data`, the real 2018-09-26 SAR scene, ERA5 and AIS live in a separate folder. Point the app at it:
```bash
# in the project's local .env (git-ignored), or as an environment variable:
AEGIS_DATA_ROOT="/path/to/AEGIS-Sentinel-Oil-Spill-main 3"      # the folder that contains ml/datasets/radar_data/ and Data/
```
Both the Node server (`server/lib/dataroot.ts`) and the Python tools (`ml/data_root.py`) resolve a data path in this
order: external root, external root with `Data`/`data` case swapped, then the repository. `/api/health` reports
`data_root: {configured, present}` and each inventory entry, without printing the path. No user name is hard-coded.

### Real-data workflow (all commands from the project root)
```bash
export AEGIS_DATA_ROOT="$HOME/Desktop/AEGIS-Sentinel-Oil-Spill-main 3"     # or set it in .env
python3 ml/evaluation/run_eval.py --label baseline          # frozen U-Net on the 7 held-out scenes -> ml/results/eval_baseline.json (+ leakage checks)
python3 ml/inference/run_unet_scene.py --normalization scene  # frozen U-Net on the real 2018-09-26 scene -> polygons (MODEL_PREDICTION)
python3 scripts/fetch_hycom_currents.py                       # real 2018 surface currents (HYCOM analysis, no credentials) -> data/currents/
python3 ml/training/train.py --dry-run                        # candidate experiment preflight (writes nothing)
python3 ml/training/train.py --epochs 6 --run-name six_epoch_experiment --normalization scene --early-stopping-patience 2 --augment --seed 42
python3 ml/evaluation/run_eval.py --checkpoint ml/checkpoints/candidates/<run>/candidate_best.pth --label candidate_six_epoch
python3 ml/evaluation/compare_candidate.py --candidate ml/results/eval_candidate_six_epoch.json   # decision record; never promotes
```
The production checkpoint `ml/checkpoints/unet_oil_spill_best.pth` is only ever read (its SHA-256 is recorded before and after).

Python tooling (verification, drift model, evaluation; PyTorch NOT needed):
```bash
python3 -m pip install numpy scipy pandas pillow
npm run test:python:core
npm run verify:baseline               # checkpoint hash/structure + NumPy re-run of a stored PyTorch output
```
Training/evaluation with real data needs `requirements.txt` (PyTorch, rasterio) and the labelled dataset
(see `ml/data/DATA_PROTOCOL.md`); start with `python ml/training/train.py --dry-run`.

## Docker
```bash
docker compose up --build             # web only, http://localhost:3000 (healthcheck: /api/health)
docker compose --profile api up --build   # also the optional FastAPI service on :8000
```
The image build fails if a required runtime file is missing (`scripts/check-runtime-files.mjs --build`).
The container runs as the unprivileged `node` user on Node 22.

## Public judge demonstration (Render Free) — ACTIVE TARGET

One free Render web service, built from this repository's `Dockerfile`, configured by `render.yaml`.
Full instructions and the judge checklist: **[RENDER_DEPLOYMENT.md](RENDER_DEPLOYMENT.md)**.

```bash
git add -A && git commit -m "Deploy VIKSIT-NETRA demo to Render Free" && git push origin main
# then: Render dashboard -> New -> Blueprint -> select this repo -> Apply
```

Render Free is **512 MB RAM / 0.1 CPU**. Measured here: a complete investigation peaks at **127 MB**
and finishes in **0.8 s** locally, so the whole workflow runs live. Full-scene U-Net inference peaks
at **1.05 GB**, which does not fit, so the image defaults to `WITH_MODEL_RUNTIME=false`: the
segmentation is served from the bundled precomputed `MODEL_PREDICTION` (labelled as such) and
"Verify detection" honestly reports that live re-inference is unavailable rather than faking one.
Free instances sleep after 15 minutes idle; the next request takes ~30-60 s. No keep-alive hack is
included by design — warm the URL yourself before a demonstration.

To restore live inference, deploy the same image to any host with >= 2 GB RAM built with
`--build-arg WITH_MODEL_RUNTIME=true`. No application code changes.

## Archived: Google Cloud Run (deprecated)

`scripts/deploy-cloudrun.sh` and `.gcloudignore` are kept as a reference for a >= 2 GB deployment.
The script refuses to run unless you set `VIKSIT_ALLOW_GCP=1`. Cloud Run requires a billing account,
which is why it is no longer the target. **Do not follow this path for the SIH demonstration.**

## Cloud (Procfile)
`web: node dist-server/server.cjs`. Use a **Node** buildpack/runtime (the repository also contains
`requirements.txt`; select Node explicitly), build command `npm ci && npm run build`, and let the platform
set `PORT`. The server binds `HOST` (default `0.0.0.0`).

## Environment variables (Express)
| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | 3000 / 0.0.0.0 | listen address |
| `APP_MODE` | REAL | initial UI mode label |
| `AEGIS_MAX_CONCURRENT_JOBS` | 2 | concurrent investigations/drifts before HTTP 429 |
| `AEGIS_ALLOW_FRAMING` | 0 | `1` disables `X-Frame-Options: DENY` |
| `AEGIS_DATA_ROOT` | unset | external data root (see above) |
| `AEGIS_ORCHESTRATOR` | auto | `auto` = real LangGraph when it loads, else the labelled `DETERMINISTIC_FALLBACK`; `langgraph` = same, loud on failure; `deterministic` = force the fallback |
| `AEGIS_UNET_VARIANT` | scene | which stored U-Net normalisation variant of the 2018 scene the server uses (`scene` or `patch`) |
| `CARTO_API_KEY` / `VITE_CARTO_API_KEY` | empty | basemap key, read ONLY by the server (tile proxy `/api/basemap/{z}/{x}/{y}.png`); never sent to the browser or compiled into the bundle |

A local `.env` is loaded if present (never committed). Real environment variables take precedence.

## LangGraph orchestration (verified)
`@langchain/langgraph` and `@langchain/core` are installed dependencies. By default (`AEGIS_ORCHESTRATOR=auto`) the 12
AEGIS nodes execute inside a real LangGraph `StateGraph`; the investigation view reports
`orchestrator_status: "LANGGRAPH"`, the package versions and how many nodes the LangGraph runtime invoked. If the package
cannot be loaded the run is labelled `DETERMINISTIC_FALLBACK` (same nodes, same results). The nodes are rule-based
computations: no language model is used anywhere, so nothing in an investigation is AI-generated text or numbers.
Counterfactual checks (exclude vessel, forcing sensitivity) run on demand from the UI/API, not as an automatic graph node.
`npm run test:agents` runs both orchestrators and checks they agree.

## Basemap key (CARTO)
Put the key in the local `.env` (git-ignored). The server reads it and proxies tiles at `/api/basemap/{z}/{x}/{y}.png`; the
browser only sees that path. `.env.example` keeps the variable empty. Verify no leak with `npm run build` and a search of
`dist/` for the key value.
