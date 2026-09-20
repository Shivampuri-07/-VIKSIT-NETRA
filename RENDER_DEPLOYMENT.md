# VIKSIT-NETRA — Render Free deployment

**Team:** Viksit Tech · **Target:** one free Render web service, public HTTPS URL, no credit card.

This is the **active** deployment path. The Google Cloud Run files (`scripts/deploy-cloudrun.sh`,
`.gcloudignore`) are kept only as an archived reference for a ≥ 2 GB host and are disabled by default.

---

## Read this first: what Render Free can and cannot run

Render's free web service is **512 MB RAM and 0.1 CPU**. Measured on this project:

| Workload | Measured | Fits in 512 MB? |
| --- | --- | --- |
| Express server, idle | ~80 MB RSS | Yes |
| **Complete investigation** (drift, AIS, attribution, evidence, hypotheses, report) | **127 MB peak RSS, 0.8 s** | **Yes** |
| Full-scene live U-Net inference | **1.05 GB peak RSS, 25.9 s on 2 CPU threads** | **No** |

So on Render Free:

* **Everything in the judge workflow runs live per request** — Lagrangian drift and backtracking,
  AIS track reconstruction and correlation, candidate scoring, evidence fusion, counterfactuals,
  competing hypotheses, risk, recommendations and the PDF report. The LangGraph StateGraph
  orchestrates all 12 nodes exactly as it does locally.
* **The U-Net segmentation is the bundled precomputed result**, labelled `PRECOMPUTED DEMO RESULT`
  in the UI. It is the genuine output of the frozen checkpoint on the real Sentinel-1 raster,
  produced offline — not a hand-drawn polygon and not synthetic.
* **"Verify detection" reports that live re-inference is unavailable on this deployment** instead of
  running. It does not fabricate a result. Verified: the endpoint returns HTTP 503
  `MODEL_RUNTIME_UNAVAILABLE` with a plain-language explanation, and the panel shows the
  `PRECOMPUTED DEMO RESULT` badge with the reason.

Putting PyTorch on a 512 MB instance would be worse than leaving it out: the judge would see a "Run
the model live" button, press it, and the container would be OOM-killed mid-demonstration. The
Dockerfile therefore defaults to `WITH_MODEL_RUNTIME=false`, which is what Render builds.

**To get live inference back**, deploy the same image to any host with ≥ 2 GB RAM and a real vCPU,
built with `--build-arg WITH_MODEL_RUNTIME=true`. No application code changes. See the appendix for
a free option that has enough RAM.

### Sleep behaviour (expected, do not work around)

Free instances **spin down after 15 minutes without traffic**, and the next request takes
**roughly 30–60 seconds** while Render starts the container. Render shows its own loading page during
this. No keep-alive pinger, cron job or synthetic traffic has been added — that would abuse the free
tier.

**For the SIH demonstration: open the URL yourself 2–3 minutes before the judges do.** Once warm it
stays warm while they use it.

---

## Deployment steps

### A. Create or log in to Render
Go to <https://render.com> and sign up with your GitHub account. The free web service path does not
require a credit card.

### B. Push this repository to GitHub
Render deploys from GitHub, so the changes must be pushed first. The repo is already connected:

```bash
cd "/Users/satyampuri/Desktop/AEGIS-Sentinel-Oil-Spill-CLOUD-FINAL"
git add -A
git commit -m "Deploy VIKSIT-NETRA demo to Render Free"
git push origin main
```

Confirm `data/sentinel1/real/2018_09_26.tif` (34.6 MB) and
`ml/checkpoints/unet_oil_spill_best.pth` (17 MB) are included — the demo needs both. Neither is
anywhere near GitHub's 100 MB per-file limit.

### C. Create the service
In the Render dashboard: **New → Web Service → Build and deploy from a Git repository**, then select
`Shivampuri-07/-VIKSIT-NETRA`.

### D. Choose Docker
Render reads `render.yaml` automatically if you use **New → Blueprint** instead, which is the easier
route and sets everything below for you. If you create the service manually, set:

| Field | Value |
| --- | --- |
| Language / Runtime | **Docker** |
| Dockerfile Path | `./Dockerfile` |
| Docker Build Context Directory | `.` |
| Instance Type | **Free** |
| Region | Singapore (closest to India) |
| Health Check Path | `/api/health` |
| Start Command | *leave empty* — the image's `CMD` is already the tested production entrypoint |

### E. Service type
**Web Service.** One service only. No database, no Redis, no worker, no cron, no disk.

### F. Environment variables

**Required: none.** The demo is fully self-contained — no API key, no database, no external service.

Render injects `PORT` itself; the server already binds `0.0.0.0` and honours it (both set in the
Dockerfile). Do not set `PORT` manually.

Optional, already set by `render.yaml`:

| Variable | Value | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `production` | production mode (also implied by the compiled bundle) |
| `AEGIS_MAX_CONCURRENT_JOBS` | `1` | concurrent investigations before HTTP 429; 1 suits 0.1 CPU |
| `AEGIS_UPLOAD_DIR` | `/tmp/viksit-netra-uploads` | ephemeral upload scratch space |

Not needed for the demo — leave every one of these unset:
`COPERNICUS_*`, `CDS_API_KEY`, `AIS_DATA_DIR`, `DATABASE_URL`, `AEGIS_DATA_ROOT`,
`VITE_CARTO_API_KEY` / `CARTO_API_KEY`. The map falls back to CARTO's public basemap with no key,
and the app reads only its bundled data. Never paste a secret into the dashboard for this demo.

### G. Deploy
Click **Create Web Service** (or **Apply** for a Blueprint).

### H. Wait for the build
First build takes roughly **5–12 minutes** (npm ci, Vite build, image assembly). Watch the log for:

```
13/13 required files present; 6/6 optional.
```

That line is `scripts/check-runtime-files.mjs --build`, which **fails the image build** if any
runtime data file is missing — so a green build means the demo data is really in the image.

### I. Open the public URL
Render gives you `https://viksit-netra.onrender.com` (or `https://viksit-netra-<suffix>.onrender.com`
if the name is taken). Check health first:

```bash
curl https://<your-service>.onrender.com/api/health
```

Expect `"status":"healthy"`, `"model":"unet_oil_spill_best"`, `"available_scenes":4`, and
`"model_runtime":{"available":false,...}` — that last one is correct and expected on Free.

### J. Judge test checklist

| # | Step | Expected |
| --- | --- | --- |
| 1 | Open the URL | VIKSIT-NETRA landing page, "Service ready" |
| 2 | Read the landing page | Scenario, real data sources, live-vs-precomputed split, measured metrics |
| 3 | Click **Launch Demo Investigation** | Workbench opens, investigation runs |
| 4 | Map | Basemap, spill polygons, no blank tiles |
| 5 | Spill geometry | 53.455 km², 9 polygons, `MODEL_PREDICTION` chip |
| 6 | **Verify detection** panel | `PRECOMPUTED DEMO RESULT` + honest "not available in this deployment" |
| 7 | Backtracking | 300-particle ensemble over 12 h, origin envelope |
| 8 | Vessel tracks | Real AIS tracks drawn (13,104 records, 56 vessels) |
| 9 | Candidates | 87 candidates, 8 high priority, 7 medium |
| 10 | Evidence | Per-factor breakdown, contradicting evidence, narrative |
| 11 | Analytics | Charts render |
| 12 | Hypotheses | 4 competing hypotheses |
| 13 | Counterfactuals | Exclude-vessel and forcing-sensitivity run |
| 14 | Forecast | 4 horizons (6/12/24/48 h) |
| 15 | **Generate report** | PDF downloads, no local file paths inside |
| 16 | Settings → **Reset demo** | Returns to landing page, state cleared |
| 17 | Refresh browser | Workbench restored, no error |
| 18 | New private window | Clean landing page, no inherited state |
| 19 | `/api/health` | JSON, no secrets |
| 20 | Phone / narrow window | Layout usable |

---

## Appendix: the free option that keeps live inference

If the "Verify detection" live run matters for your presentation, **Hugging Face Spaces** has a free
CPU tier with substantially more RAM than Render Free and does not ask for a card. It supports Docker
directly, so the same image works — build it with `--build-arg WITH_MODEL_RUNTIME=true` and set the
Space to listen on its expected port. Check the current free-tier specs on their pricing page before
committing to it, since free-tier limits change.

This is offered only as an alternative; **Render Free as configured here is a complete, honest demo**
of the whole investigation workflow.
