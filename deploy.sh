#!/usr/bin/env bash
set -euo pipefail

# -------------------------
# Configuration
# -------------------------

SERVICE_NAME="gcp-mcp"
REGION="europe-west1"

# Service account used by Cloud Run (must already exist)
# Grant yourself roles/iam.serviceAccountUser
PROJECT="$(gcloud config get-value project)"
SERVICE_ACCOUNT="gcp-mcp-sa@$(gcloud config get-value project).iam.gserviceaccount.com"
echo "Granting yourself roles/iam.serviceAccountUser"
gcloud iam service-accounts add-iam-policy-binding "$SERVICE_ACCOUNT" \
    --member="user:$GCLOUD_USER" \
    --role="roles/iam.serviceAccountUser" \
    --project "$PROJECT"

# Cloud Run settings
TIMEOUT_SECONDS="3600"      # 1 hour (important for MCP/SSE)
CONCURRENCY="20"            # MCP sessions per container
MEMORY="1Gi"
CPU="1"

# -------------------------
# Sanity checks
# -------------------------

PROJECT_ID="$(gcloud config get-value project)"

if [[ -z "$PROJECT_ID" ]]; then
  echo "❌ No active gcloud project set"
  echo "Run: gcloud config set project YOUR_PROJECT_ID"
  exit 1
fi

echo "🚀 Deploying MCP server"
echo "Project:  $PROJECT_ID"
echo "Region:   $REGION"
echo "Service:  $SERVICE_NAME"
echo "SA:       $SERVICE_ACCOUNT"
echo

# -------------------------
# Enable required APIs
# -------------------------

echo "🔧 Enabling required APIs..."
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com

# -------------------------
# Deploy to Cloud Run
# -------------------------

echo "📦 Deploying to Cloud Run..."

gcloud run deploy "$SERVICE_NAME" \
  --source . \
  --region "$REGION" \
  --platform managed \
  --allow-unauthenticated \
  --service-account "$SERVICE_ACCOUNT" \
  --timeout "$TIMEOUT_SECONDS" \
  --concurrency "$CONCURRENCY" \
  --memory "$MEMORY" \
  --cpu "$CPU"

# -------------------------
# Show service URL
# -------------------------

SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" \
  --region "$REGION" \
  --format='value(status.url)')

echo
echo "✅ Deployment complete!"
echo "🌍 Service URL:"
echo "   $SERVICE_URL/mcp"
echo
echo "👉 Use this in FastMCP:"
echo "   https://$SERVICE_URL/mcp"
