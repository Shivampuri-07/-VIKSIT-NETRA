#!/usr/bin/env bash
# =============================================================================
# DEPRECATED — NOT THE ACTIVE DEPLOYMENT PATH.
#
# The active target is RENDER FREE. See RENDER_DEPLOYMENT.md and render.yaml.
# This script is kept only as a reference for redeploying to a host with >= 2 GB
# RAM, where live model inference can run (Cloud Run needs a billing account,
# which is why it was abandoned).
#
# It intentionally refuses to run unless you opt in:
#   VIKSIT_ALLOW_GCP=1 ./scripts/deploy-cloudrun.sh
# =============================================================================
if [[ "${VIKSIT_ALLOW_GCP:-0}" != "1" ]]; then
  echo "This GCP/Cloud Run script is deprecated; the active target is Render Free." >&2
  echo "See RENDER_DEPLOYMENT.md. To override: VIKSIT_ALLOW_GCP=1 $0" >&2
  exit 2
fi
# Deploy VIKSIT-NETRA to Google Cloud Run as a single service.
#
#   ./scripts/deploy-cloudrun.sh [PROJECT_ID] [REGION] [SERVICE]
#
# Prerequisites (one-time, interactive — run these yourself):
#   gcloud auth login
#   gcloud config set project <PROJECT_ID>
#
# The image is built by Cloud Build from this directory (see .gcloudignore for what is uploaded),
# so no local Docker daemon is required. Nothing secret is passed on the command line; set any
# optional key with `gcloud run services update ... --set-env-vars`.
set -euo pipefail

PROJECT="${1:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${2:-asia-south1}"
SERVICE="${3:-viksit-netra}"

if [[ -z "$PROJECT" || "$PROJECT" == "(unset)" ]]; then
  echo "No project set. Run: gcloud config set project <PROJECT_ID>" >&2
  exit 1
fi

echo "==> Project : $PROJECT"
echo "==> Region  : $REGION"
echo "==> Service : $SERVICE"

echo "==> Enabling required APIs (idempotent)"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  --project "$PROJECT"

# Memory: full-scene U-Net inference peaked at ~1.05 GB RSS when measured, so 2 GB is the floor.
# CPU 2 matches OMP_NUM_THREADS=2 in the image.
# Timeout 300 s: a cold container plus a full-scene live inference must fit inside one request.
# Concurrency 4: the server also caps its own heavy jobs (AEGIS_MAX_CONCURRENT_JOBS).
# NOTE: `gcloud run deploy --source` cannot pass Docker build args either, so this path now builds
# WITHOUT the model runtime (the Dockerfile default changed to false for Render). To restore live
# inference here, build and push the image explicitly first:
#   gcloud builds submit --tag <IMAGE> --substitutions=_ARG=  # or: docker build --build-arg WITH_MODEL_RUNTIME=true
# then deploy with --image <IMAGE> instead of --source .
echo "==> Building and deploying (Cloud Build; no local Docker needed)"
gcloud run deploy "$SERVICE" \
  --source . \
  --project "$PROJECT" \
  --region "$REGION" \
  --platform managed \
  --allow-unauthenticated \
  --memory 2Gi \
  --cpu 2 \
  --timeout 300 \
  --concurrency 4 \
  --max-instances 4 \
  --min-instances 0 \
  --port 3000 \
  --set-env-vars "NODE_ENV=production,AEGIS_MAX_CONCURRENT_JOBS=2,AEGIS_UPLOAD_DIR=/tmp/viksit-netra-uploads"

URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format='value(status.url)')"
echo
echo "==> Deployed: $URL"
echo "==> Health  : $URL/api/health"
echo
echo "To remove cold starts during a live demonstration (billed while warm):"
echo "  gcloud run services update $SERVICE --project $PROJECT --region $REGION --min-instances 1"
echo "And to let it scale back to zero afterwards:"
echo "  gcloud run services update $SERVICE --project $PROJECT --region $REGION --min-instances 0"
