# syntax=docker/dockerfile:1
# AEGIS web application: Express API + built React UI (single service).
# Node 22 LTS (Node 20 reached end-of-life in April 2026).

# ---------- build stage ----------
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
# Runtime dependency tree: only what dist-server/server.cjs actually loads (see the script's header).
# Installed separately so the React/PDF/chart packages — already compiled into dist/ by Vite — are
# not shipped in the runtime image.
RUN node scripts/make-runtime-package.mjs > /tmp/package.json \
 && mkdir -p /runtime && mv /tmp/package.json /runtime/package.json \
 && cd /runtime && npm install --omit=dev --no-audit --no-fund

# ---------- runtime stage ----------
FROM node:22-slim AS runtime
# WITH_MODEL_RUNTIME controls whether CPU PyTorch + rasterio are installed, i.e. whether THIS
# deployment can execute the U-Net itself (SAR upload scoring and POST /api/demo/verify-inference).
#
#   false (default)  ~315 MB image, ~95 MB RSS. Suits a 512 MB host such as Render Free.
#                    The model endpoints report MODEL_RUNTIME_UNAVAILABLE and the UI labels the
#                    detection PRECOMPUTED DEMO RESULT. Nothing is faked; the feature is absent.
#   true             ~1.2 GB image. Full-scene inference was MEASURED at ~1.05 GB peak RSS, so the
#                    host needs >= 2 GB RAM and a real vCPU, or the container will be OOM-killed
#                    mid-demonstration. Build it explicitly:
#                      docker build --build-arg WITH_MODEL_RUNTIME=true -t viksit-netra .
#
# The default is false because render.yaml cannot pass Docker build args: Render must get the
# configuration that fits its instance, without anyone remembering a flag.
# The training dataset is never part of either image.
ARG WITH_MODEL_RUNTIME=false
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    AEGIS_PYTHON=python3 \
    AEGIS_UPLOAD_DIR=/tmp/viksit-netra-uploads \
    OMP_NUM_THREADS=2 \
    MKL_NUM_THREADS=2
WORKDIR /app
COPY requirements-inference.txt ./
# torch is taken from the CPU wheel index on purpose: the default PyPI wheel drags in ~2.5 GB of
# CUDA libraries that a CPU-only container can never use.
RUN if [ "$WITH_MODEL_RUNTIME" = "true" ]; then \
      apt-get update && apt-get install -y --no-install-recommends python3 python3-pip \
      && pip3 install --no-cache-dir --break-system-packages \
           --extra-index-url https://download.pytorch.org/whl/cpu \
           -r requirements-inference.txt \
      && rm -rf /var/lib/apt/lists/* /root/.cache/pip; \
    fi
COPY --from=build --chown=node:node /runtime/package.json ./package.json
COPY --from=build --chown=node:node /runtime/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/dist-server ./dist-server
COPY --from=build --chown=node:node /app/scripts/check-runtime-files.mjs ./scripts/check-runtime-files.mjs
# runtime data used by the UI/server (see scripts/check-runtime-files.mjs)
COPY --from=build --chown=node:node /app/data/sample ./data/sample
COPY --from=build --chown=node:node /app/data/ais/2018 ./data/ais/2018
COPY --from=build --chown=node:node /app/data/era5 ./data/era5
COPY --from=build --chown=node:node /app/data/sentinel1/derived ./data/sentinel1/derived
COPY --from=build --chown=node:node /app/data/currents ./data/currents
# The real Sentinel-1 VV raster of the demo scene: original float32 sigma0-dB values, losslessly
# DEFLATE-compressed (34.6 MB, pixel-identical to the 52 MB source). This is what makes live
# re-inference possible in the cloud; it is NOT a screenshot or an RGB quicklook.
COPY --from=build --chown=node:node /app/data/sentinel1/real ./data/sentinel1/real
# model prediction / reference polygons + the measured baseline evaluation (small JSON only; the probability rasters stay out of the image)
COPY --from=build --chown=node:node /app/ml/results/inference/2018_09_26/unet_geometry_scene.json /app/ml/results/inference/2018_09_26/unet_geometry_patch.json /app/ml/results/inference/2018_09_26/reference_label_geometry.json ./ml/results/inference/2018_09_26/
COPY --from=build --chown=node:node /app/ml/results/eval_baseline.json ./ml/results/eval_baseline.json
COPY --from=build --chown=node:node /app/ml/model_registry.json ./ml/model_registry.json
COPY --from=build --chown=node:node /app/ml/extensions/capabilities.json ./ml/extensions/capabilities.json
COPY --from=build --chown=node:node /app/ml/checkpoints/unet_oil_spill_best.pth ./ml/checkpoints/unet_oil_spill_best.pth
# model inference code for the upload endpoint (small text files; no dataset)
COPY --from=build --chown=node:node /app/ml/__init__.py /app/ml/data_root.py ./ml/
COPY --from=build --chown=node:node /app/ml/models ./ml/models
COPY --from=build --chown=node:node /app/ml/evaluation ./ml/evaluation
COPY --from=build --chown=node:node /app/ml/inference ./ml/inference
COPY --from=build --chown=node:node /app/ml/metrics ./ml/metrics
COPY --from=build --chown=node:node /app/ml/datasets/__init__.py ./ml/datasets/
COPY --from=build --chown=node:node /app/ml/verification ./ml/verification
COPY --from=build --chown=node:node /app/ml/baseline ./ml/baseline
# fail the image build if any required runtime file is missing or the server bundle leaked into dist/
RUN node scripts/check-runtime-files.mjs --build
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist-server/server.cjs"]
