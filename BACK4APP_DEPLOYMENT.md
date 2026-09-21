> **DEPRECATED — do not use this path.**
>
> Back4App's free plan **stops the container 60 minutes after each deploy and never restarts it**.
> Measured on the live deployment: serving normally 18:45–19:13, `404 not found` by 19:31, still
> `404` 25 minutes later, and repeated requests did **not** wake it. Back4App's own template repo
> states it plainly: *"On the free plan the container lives 60 minutes per deploy."*
>
> That makes it unusable when you cannot predict when someone will visit: they get a dead link, not a
> slow one. The active target is **Render free**, which sleeps but **wakes on request**:
> see **[RENDER_DEPLOYMENT.md](RENDER_DEPLOYMENT.md)**.
>
> Everything below about *what runs live vs precomputed*, the measured memory figures and the judge
> checklist remains accurate and applies to any host.

# VIKSIT-NETRA — Back4App Containers deployment (ACTIVE TARGET)

**Team:** Viksit Tech · **Target:** free Back4App Container, public HTTPS URL, **no credit card**.

Deprecated, kept for reference only and unused by the application:
`NORTHFLANK_DEPLOYMENT.md`, `RENDER_DEPLOYMENT.md` + `render.yaml`,
`scripts/deploy-cloudrun.sh` + `.gcloudignore`.

---

## Why Back4App

Free hosting was re-verified in September 2026, because these policies change often. Two findings
forced the choice:

| Platform | Genuinely free? | Card required? | Outcome |
| --- | --- | --- | --- |
| Hugging Face Spaces (Docker) | **No** — PRO plan required to create | — | Ruled out |
| Fly.io | **No** | Yes | Ruled out |
| Koyeb | Free tier **closed to new signups** | — | Ruled out |
| Railway | Free plan = **$1/month credit** | No | Cannot sustain 24/7 |
| Clever Cloud | Trial credits only | No | Not permanent |
| Zeabur | Free plan manages **your own** hardware | — | No hosted compute |
| Northflank Sandbox | $0/month, but… | **YES** — verified by API rejection | Ruled out |
| Render | Yes, 512 MB, sleeps 15 min | No | Excluded by project decision |
| **Back4App Containers** | **Yes** — 0.25 CPU, 256 MB, 100 GB transfer | **No** | **Selected** |

Northflank was attempted first and rejected the service creation with
`HTTP 409 — "Please complete your account by adding a default payment method."` Their documentation
confirms it: *"all users must add a payment method to start creating resources on Northflank,
regardless of plan selection."* Back4App states the opposite for its free tier: deploy a Dockerised
project *"at no charge with no credit card required."*

## Fit against the free limits

Measured on this project, not estimated:

| Workload | Measured | Fits 256 MB? |
| --- | --- | --- |
| Express server, idle | ~80 MB RSS | Yes |
| **3 back-to-back complete investigations** | **132 MB peak RSS, no OOM** | **Yes** (~50 % headroom) |
| Full-scene live U-Net inference | **1.05 GB peak RSS, 25.9 s** | **No** |

**No free tier anywhere provides the ~1.05 GB live inference needs.** Therefore:

* **Live, per request:** Lagrangian drift and backtracking, AIS track reconstruction and correlation,
  candidate scoring, evidence fusion, counterfactual analysis, competing hypotheses, uncertainty,
  risk, recommendations, analytics, PDF report generation, map layers, upload validation — all 12
  nodes orchestrated by the real LangGraph `StateGraph`.
* **Precomputed:** only the U-Net segmentation mask. It is the genuine frozen-checkpoint output on
  the real Sentinel-1 raster, computed offline — not synthetic, not hand-drawn. The UI labels it
  `PRECOMPUTED DEMO RESULT`.
* **"Verify detection" is preserved, not removed.** On this tier it returns HTTP 503
  `MODEL_RUNTIME_UNAVAILABLE` with a plain explanation instead of running. It never presents
  precomputed output as live inference.

To restore live inference later, deploy the same image to any host with ≥ 2 GB RAM built with
`--build-arg WITH_MODEL_RUNTIME=true`. No application code changes.

## Compatibility: no Dockerfile changes were needed

Back4App requires a Dockerfile in the root directory, a Dockerfile that `EXPOSE`s a TCP port, and an
app that listens on the injected `PORT`. All three were already true and were verified:

| Requirement | Status |
| --- | --- |
| `Dockerfile` in repo root | Present |
| Dockerfile exposes a TCP port | `EXPOSE 3000` |
| App listens on injected `PORT` | `const PORT = Number(process.env.PORT \|\| 3000)` — tested with `PORT=7777`, health returned 200 |
| Binds all interfaces | `HOST \|\| "0.0.0.0"` — verified listening on `*:7777` |
| Env var names uppercase/underscore | `NODE_ENV`, `AEGIS_MAX_CONCURRENT_JOBS`, `AEGIS_UPLOAD_DIR` |

---

## Deployment steps

The code is already pushed. Back4App Containers has no public deployment API, so these steps are
done in their dashboard.

### 1. Sign up
<https://www.back4app.com/signup-containers> — sign up **with GitHub**. No credit card is requested
for the free Containers plan.

### 2. Create the container app
**Containers → Deploy your app → Import a GitHub repository.** Authorise the Back4App GitHub app and
grant access to `Shivampuri-07/-VIKSIT-NETRA`, then select that repository.

### 3. Configure

| Field | Value |
| --- | --- |
| App name | `viksit-netra` (becomes part of the public URL) |
| Branch | `main` |
| Root directory | `/` (leave default — the Dockerfile is at the repo root) |
| Auto deploy | On (optional; redeploys on each push) |
| Plan | **Free** |

### 4. Environment variables

**Required: none.** The demo is entirely self-contained — no API key, no database, no external
service. **Do not paste any secret here.**

Add these three only (all non-secret, and they satisfy Back4App's uppercase/underscore rule):

| Key | Value | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `production` | production mode |
| `AEGIS_MAX_CONCURRENT_JOBS` | `1` | concurrent investigations before HTTP 429; suits a small shared vCPU |
| `AEGIS_UPLOAD_DIR` | `/tmp/viksit-netra-uploads` | ephemeral upload scratch space |

Do **not** set `PORT` — Back4App injects it and the server follows it.

Leave unset, each has a working fallback: `COPERNICUS_*`, `CDS_API_KEY`, `AIS_DATA_DIR`,
`DATABASE_URL`, `AEGIS_DATA_ROOT`, `CARTO_API_KEY` / `VITE_CARTO_API_KEY`. Without a CARTO key the
map uses CARTO's public basemap, which is the intended free-tier behaviour.

### 5. Deploy and watch the build

First build takes roughly **5–15 minutes** (npm ci, Vite build, image assembly). In the build log,
look for:

```
15/15 required files present; 6/6 optional.
```

That is `scripts/check-runtime-files.mjs --build`, which **fails the image build** if any runtime
data file is missing — so a green build proves the demo data is really inside the image.

Then in the *application* log, confirm the server reports its port:

```
 Server : http://localhost:<injected port>  (production)
```

### 6. Get the URL and verify

Back4App issues `https://<app-name>-<subdomain>.b4a.run`. Check health before opening the UI:

```bash
curl https://<your-url>/api/health
```

Expect `"status":"healthy"`, `"model":"unet_oil_spill_best"`, `"available_scenes":4`, and
`"model_runtime":{"available":false,...}` — that last field is **correct and expected** on a free
instance, not a failure.

### Sleep and cold starts (measured, not assumed)

Free containers sleep when idle and wake on the next request. **Measured on this deployment:**

| Situation | Time to first byte |
| --- | --- |
| After ~20 minutes idle | **4.9 s**, then 3.3 s, then 0.59 s |
| After a long gap (worst seen) | **14.2 s** |

A visitor arriving unannounced therefore sees a short load, not a dead site.

**Sleep cannot be disabled on the free plan** — always-on requires a paid tier. **No keep-alive
pinger has been added, and none should be**: it is fake traffic, it consumes the free allowance, and
the measured wake time does not justify it.

Back4App Containers plans (from their pricing page, September 2026). Investigation times are linear
extrapolations from the measured 0.25-CPU result, so treat them as directional:

| Plan | CPU | RAM | Price | Investigation (est.) | Live inference? |
| --- | --- | --- | --- | --- | --- |
| **Free** (this deployment) | 0.25 | 256 MB | **$0** | ~85 s measured | No |
| Shared | 0.5 | 512 MB | $5/mo | ~45 s | No |
| Shared 2 | 1 | 1 GB | $15/mo | ~21 s | No |
| Shared 3 | 1 | **2 GB** | $25/mo | ~21 s | **Yes** — clears the 1.05 GB measured peak |

Only Shared 3 has enough RAM to enable live re-inference; it would need the image rebuilt with
`--build-arg WITH_MODEL_RUNTIME=true`.

Note on an earlier figure: a "600 active hours/month" limit appeared in third-party write-ups and was
repeated here. **Back4App's own pricing page does not state an hours limit** for the free plan, only
0.25 CPU / 256 MB / 100 GB transfer, so that number is unverified and has been removed.

---

## Verified live deployment (20 Sep 2026)

**Public URL: <https://viksitnetra-416jquzz.b4a.run>**

Tested against the running public service, not locally:

| Check | Result |
| --- | --- |
| `/api/health` | `healthy`, `unet_oil_spill_best`, 4 scenes, 11/12 data files present (the absent one is the training label mask, correctly excluded) |
| Landing page + bundle | HTTP 200; `Launch Demo Investigation`, `PRECOMPUTED DEMO RESULT`, `LIVE MODEL INFERENCE`, `Reset demo`, `DEMO MODE` all present |
| Orchestrator | `LANGGRAPH`, 12 nodes invoked, `llm_used: false`, `RULE_BASED_COMPUTATION` |
| Detection | `MODEL_PREDICTION`, 53.455 km², 9 polygons — identical to local |
| AIS | 13,104 real MarineCadastre records, 56 vessels, `synthetic: false` |
| Candidates | 87 total, 8 high priority, 7 medium |
| Drift | 300 particles, 12 h backward; 48 h forward, 4 snapshots, 97 centroid points, 40 tracks |
| Hypotheses / evidence graph | 4 hypotheses; 29 nodes, 24 edges; 6 recommendations; report present |
| `POST /api/demo/verify-inference` | HTTP 503 `MODEL_RUNTIME_UNAVAILABLE` — degrades honestly, never fabricates |
| Upload of a non-raster | HTTP 503 `MODEL_RUNTIME_UNAVAILABLE` |
| Security | 4/4 headers; path traversal 404 (raw and encoded); errors sanitised; unknown API route JSON 404 |
| Basemap | `mode: public` — works with no CARTO key |
| SAR overlay asset | HTTP 200, 465,777 bytes |
| `/api/selftest` | `passed: true` |

### Known limitation: ~85 s per investigation

Measured over four runs (warm and cold alike): **81 s, 88 s, 92 s, 97 s**. Profiling the live
instance attributes **96.9 %** of that to a single node:

| Node | Live | Local | Ratio |
| --- | --- | --- | --- |
| `evidence_fusion` | **78,496 ms** | 360 ms | **218x** |
| `forward_forecast` | 1,196 ms | 44 ms | 27x |
| `backward_origin` | 924 ms | 30 ms | 31x |

The short nodes are ~30x slower while the long one is 218x slower, which is the signature of CPU
quota throttling: brief nodes consume burst credit, and the sustained node is throttled to the floor.
It is the free tier's CPU share, not a defect in the application.

**Progress is not visible while it runs.** Back4App fronts containers with AWS CloudFront
(`via: 1.1 …cloudfront.net`, `x-amz-cf-pop: MAA50-P1`), which buffers the SSE stream and strips the
`X-Accel-Buffering: no` header the server already sets. Measured: the server emitted events across
80 s, but all 25 arrived in one 0.6 s burst. The workflow stepper therefore stays static and then
jumps to complete. The UI still shows a "Running" state throughout, so it is not a blank screen.

Neither issue affects correctness: every figure above matches the local run exactly.

Two mitigations exist if this matters later, neither applied here by choice:
polling `/api/investigations/:id` every ~2 s as a fallback (plain GETs are not buffered, ~0.65 s) so
the stepper animates; or more CPU on a paid tier.

**Concurrency:** `AEGIS_MAX_CONCURRENT_JOBS=1`, so a second simultaneous investigation receives
HTTP 429 until the first finishes. Verified working as designed. With ~85 s runs, two judges clicking
at the same moment will queue.

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
