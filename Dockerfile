# syntax=docker/dockerfile:1
# AEGIS web application: Express API + built React UI (single service).
# Node 22 LTS (Node 20 reached end-of-life in April 2026).

# ---------- build stage ----------
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# ---------- runtime stage ----------
FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/dist-server ./dist-server
COPY --from=build --chown=node:node /app/scripts/check-runtime-files.mjs ./scripts/check-runtime-files.mjs
# runtime data used by the UI/server (see scripts/check-runtime-files.mjs)
COPY --from=build --chown=node:node /app/data/sample ./data/sample
COPY --from=build --chown=node:node /app/data/ais/2018 ./data/ais/2018
COPY --from=build --chown=node:node /app/data/era5 ./data/era5
COPY --from=build --chown=node:node /app/data/sentinel1/derived ./data/sentinel1/derived
COPY --from=build --chown=node:node /app/data/currents ./data/currents
# model prediction / reference polygons + the measured baseline evaluation (small JSON only; the probability rasters stay out of the image)
COPY --from=build --chown=node:node /app/ml/results/inference/2018_09_26/unet_geometry_scene.json /app/ml/results/inference/2018_09_26/unet_geometry_patch.json /app/ml/results/inference/2018_09_26/reference_label_geometry.json ./ml/results/inference/2018_09_26/
COPY --from=build --chown=node:node /app/ml/results/eval_baseline.json ./ml/results/eval_baseline.json
COPY --from=build --chown=node:node /app/ml/model_registry.json ./ml/model_registry.json
COPY --from=build --chown=node:node /app/ml/extensions/capabilities.json ./ml/extensions/capabilities.json
COPY --from=build --chown=node:node /app/ml/checkpoints/unet_oil_spill_best.pth ./ml/checkpoints/unet_oil_spill_best.pth
# fail the image build if any required runtime file is missing or the server bundle leaked into dist/
RUN node scripts/check-runtime-files.mjs --build
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist-server/server.cjs"]
