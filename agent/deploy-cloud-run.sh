#!/usr/bin/env sh
set -eu

PROJECT_ID="${PROJECT_ID:-transgaz64-bitrix-mcp}"
REGION="${REGION:-europe-west1}"
SERVICE="${SERVICE:-bitrix-virtual-director}"
REPOSITORY="${REPOSITORY:-bitrix-agents}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/${SERVICE}:latest"

: "${BITRIX_WEBHOOK_BASE:?BITRIX_WEBHOOK_BASE is required}"
: "${OPENAI_API_KEY:?OPENAI_API_KEY is required}"
: "${AGENT_TOKEN:?AGENT_TOKEN is required}"

command -v gcloud >/dev/null 2>&1 || { echo "gcloud is required" >&2; exit 1; }

gcloud config set project "$PROJECT_ID"
gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com firestore.googleapis.com cloudscheduler.googleapis.com secretmanager.googleapis.com

gcloud artifacts repositories describe "$REPOSITORY" --location "$REGION" >/dev/null 2>&1 || \
  gcloud artifacts repositories create "$REPOSITORY" --repository-format docker --location "$REGION"

gcloud firestore databases describe --database='(default)' >/dev/null 2>&1 || \
  gcloud firestore databases create --database='(default)' --location="$REGION" --type=firestore-native

printf %s "$BITRIX_WEBHOOK_BASE" | gcloud secrets versions add bitrix-webhook-base --data-file=- 2>/dev/null || \
  { printf %s "$BITRIX_WEBHOOK_BASE" | gcloud secrets create bitrix-webhook-base --data-file=-; }
printf %s "$OPENAI_API_KEY" | gcloud secrets versions add openai-api-key --data-file=- 2>/dev/null || \
  { printf %s "$OPENAI_API_KEY" | gcloud secrets create openai-api-key --data-file=-; }
printf %s "$AGENT_TOKEN" | gcloud secrets versions add agent-token --data-file=- 2>/dev/null || \
  { printf %s "$AGENT_TOKEN" | gcloud secrets create agent-token --data-file=-; }

gcloud builds submit --tag "$IMAGE" .

gcloud run deploy "$SERVICE" \
  --image "$IMAGE" \
  --region "$REGION" \
  --platform managed \
  --allow-unauthenticated \
  --set-secrets BITRIX_WEBHOOK_BASE=bitrix-webhook-base:latest,OPENAI_API_KEY=openai-api-key:latest,AGENT_TOKEN=agent-token:latest \
  --set-env-vars OPENAI_MODEL="${OPENAI_MODEL:-gpt-5-mini}",ALLOWED_DIALOGS="${ALLOWED_DIALOGS:-chat9869}",DIRECTOR_DIALOG_ID="${DIRECTOR_DIALOG_ID:-1}" \
  --memory 512Mi \
  --cpu 1 \
  --min-instances 0 \
  --max-instances 2

SERVICE_URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"

gcloud scheduler jobs delete "${SERVICE}-poll" --location "$REGION" --quiet >/dev/null 2>&1 || true
gcloud scheduler jobs create http "${SERVICE}-poll" \
  --location "$REGION" \
  --schedule='* * * * *' \
  --uri="${SERVICE_URL}/poll" \
  --http-method=POST \
  --headers="x-agent-token=${AGENT_TOKEN}"

echo "Deployed: ${SERVICE_URL}"
