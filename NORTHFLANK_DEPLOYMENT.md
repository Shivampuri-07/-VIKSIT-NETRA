> **DEPRECATED — not the deployment target.** Northflank requires a payment method on file
> before any service can be created (verified: `HTTP 409 "Please complete your account by
> adding a default payment method"`), even though its Sandbox plan is $0/month.
> The active target is **Back4App Containers**: see **[BACK4APP_DEPLOYMENT.md](BACK4APP_DEPLOYMENT.md)**.

# VIKSIT-NETRA — Northflank free deployment (ACTIVE TARGET)

**Team:** Viksit Tech · **Target:** one free Northflank Sandbox service, public HTTPS URL, no credit card.

Deprecated, kept for reference only: `RENDER_DEPLOYMENT.md` + `render.yaml` (Render),
`scripts/deploy-cloudrun.sh` + `.gcloudignore` (Google Cloud Run). No application code depends on any
of them.

---

## Why Northflank

Free hosting was re-verified in September 2026 before choosing, because these policies change:

| Platform | Genuinely free? | RAM | Card | Outcome |
| --- | --- | --- | --- | --- |
| Hugging Face Spaces (Docker) | **No** — PRO plan required to create | — | — | Ruled out |
| Fly.io | **No** — "all organizations require a credit card on file" | — | Yes | Ruled out |
| Koyeb | Free tier **closed to new signups** | 512 MB | — | Ruled out |
| Railway | Free plan = **$1/month credit** | — | No | Cannot sustain 24/7 |
| Clever Cloud | Trial credits only | — | No | Not permanent |
| Zeabur | Free plan manages **your own** hardware | — | — | No hosted compute |
| Back4App Containers | Yes | 256 MB, **600 h/month** | No | Offline ~5 days/month |
| Render | Yes | 512 MB, **sleeps after 15 min** | No | Excluded by project decision |
| **Northflank Sandbox** | **Yes, permanent** | ~512 MB | **No** | **Selected** |

Northflank is the only permanent free tier that is open to new users, needs no card, **and does not
sleep** — so a judge opening the URL never waits through a cold start.

## What runs live and what is precomputed

Measured on this project, not estimated:

| Workload | Measured | Fits a free instance? |
| --- | --- | --- |
| Express server, idle | ~80 MB RSS | Yes |
| **Complete investigation** ×3 back-to-back | **132 MB peak RSS** | **Yes** |
| Full-scene live U-Net inference | **1.05 GB peak RSS, 25.9 s** | **No** |

**No free tier on any platform offers the ~1.05 GB that live inference needs.** So:

* **Live, per request:** Lagrangian drift and backtracking, AIS track reconstruction and correlation,
  candidate scoring, evidence fusion, counterfactual analysis, competing hypotheses, uncertainty,
  risk, recommendations, analytics, PDF report generation, map layers, upload validation — all 12
  nodes orchestrated by the real LangGraph `StateGraph`.
* **Precomputed:** only the U-Net segmentation mask. It is the genuine frozen-checkpoint output on
  the real Sentinel-1 raster, computed offline — not synthetic, not hand-drawn. The UI labels it
  `PRECOMPUTED DEMO RESULT`.
* **"Verify detection" is preserved, not removed.** On this tier it reports HTTP 503
  `MODEL_RUNTIME_UNAVAILABLE` with a plain explanation instead of running. It never presents
  precomputed output as live inference.

Shipping PyTorch to a 512 MB instance would be worse than omitting it: the judge would see a "Run the
model live" button, press it, and the container would be OOM-killed mid-demonstration. The Dockerfile
therefore defaults to `WITH_MODEL_RUNTIME=false`.

**To restore live inference**, deploy the same image to any host with ≥ 2 GB RAM built with
`--build-arg WITH_MODEL_RUNTIME=true`. No application code changes.

---

## Deployment

### What you do (browser, roughly five minutes)

1. **Push the code.** Northflank builds from GitHub, so commit `0fbe644` must be on the remote:
   ```bash
   cd "/Users/satyampuri/Desktop/AEGIS-Sentinel-Oil-Spill-CLOUD-FINAL"
   git push origin main
   ```
2. **Sign up** at <https://northflank.com> — "Sign up with GitHub" is simplest. No card is required
   for the Sandbox plan.
3. **Give Northflank access to the repository.** During signup, or afterwards under
   **Settings → Version control → GitHub**, authorise the Northflank GitHub app and grant it access
   to `Shivampuri-07/-VIKSIT-NETRA`.
4. **Create an API token.** **Account settings → API tokens → New token.** Grant it at least
   *Project: create/read* and *Project → Services: create/read* (account-wide read/write is fine for
   a one-off). Copy the token — it is shown once.

### What is done for you (CLI, no further input)

With the token, the deployment runs headlessly:

```bash
npx @northflank/cli login --token-login --token "$NF_TOKEN" --name viksit
npx @northflank/cli create project --input '{"name":"viksit-netra","region":"europe-west",...}'
npx @northflank/cli create service combined --input '{ ...Dockerfile build + deploy spec... }'
```

The service is a **combined** service: Northflank clones the repo, builds `./Dockerfile`, and deploys
the resulting image — the same image and the same `CMD ["node","dist-server/server.cjs"]` that was
tested locally.

### Service configuration

| Setting | Value | Why |
| --- | --- | --- |
| Type | Combined (build + deploy) | One service; no separate build pipeline |
| Build | `./Dockerfile`, context `.` | Reuses the existing production image |
| Port | `3000`, HTTP, **public** | The Dockerfile sets `ENV PORT=3000` and `EXPOSE 3000` |
| Health check | `/api/health` | The project's existing endpoint |
| Instances | 1 | Investigation state is in-memory per process |
| Compute | smallest Sandbox plan | 132 MB measured peak |

### Environment variables

**Required: none.** The demo is entirely self-contained — no API key, no database, no external
service. Do not paste any secret into the Northflank dashboard for this deployment.

Set by the deployment for safety, all non-secret:

| Variable | Value | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `production` | production mode |
| `AEGIS_MAX_CONCURRENT_JOBS` | `1` | concurrent investigations before HTTP 429; suits a shared vCPU |
| `AEGIS_UPLOAD_DIR` | `/tmp/viksit-netra-uploads` | ephemeral upload scratch space |

Leave unset — each has a working fallback: `COPERNICUS_*`, `CDS_API_KEY`, `AIS_DATA_DIR`,
`DATABASE_URL`, `AEGIS_DATA_ROOT`, `CARTO_API_KEY` / `VITE_CARTO_API_KEY`. Without a CARTO key the
map uses CARTO's public basemap, which is the intended free-tier behaviour.

### Build expectations

First build takes roughly **5–12 minutes** (npm ci, Vite build, image assembly). Watch for:

```
15/15 required files present; 6/6 optional.
```

That is `scripts/check-runtime-files.mjs --build`, which **fails the image build** if any runtime data
file is missing — so a green build proves the demo data is really inside the image.

### Public URL

Northflank issues `https://<service>--<project>--<account>.code.run`. Verify health before opening the
UI:

```bash
curl https://<your-url>/api/health
```

Expect `"status":"healthy"`, `"model":"unet_oil_spill_best"`, `"available_scenes":4`, and
`"model_runtime":{"available":false,...}` — that last field is **correct and expected** on a free
instance, not a failure.

---

## Judge checklist

| # | Step | Expected |
| --- | --- | --- |
| 1 | Open the URL | VIKSIT-NETRA landing page, "Service ready" |
| 2 | Read the landing page | Scenario, real data sources, live-vs-precomputed split, measured metrics |
| 3 | Click **Launch Demo Investigation** | Workbench opens, investigation runs |
| 4 | Map | Basemap, spill polygons, no blank tiles |
| 5 | Spill geometry | 53.455 km², 9 polygons, `MODEL_PREDICTION` chip |
| 6 | **Verify detection** | `PRECOMPUTED DEMO RESULT` + honest "not available in this deployment" |
| 7 | Backtracking | 300-particle ensemble over 12 h, origin envelope |
| 8 | Vessel tracks | Real AIS tracks (13,104 records, 56 vessels) |
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
