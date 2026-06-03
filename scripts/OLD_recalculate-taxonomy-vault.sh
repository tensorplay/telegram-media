#!/usr/bin/env bash
set -euo pipefail

# Load .env from the current project directory if it exists.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

ENV_FILE="${ENV_FILE:-$PROJECT_DIR/.env}"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

API_URL="${API_URL:-http://localhost:3001/api/recalculate-taxonomy}"
API_KEY="${MULTIPLATFORM_MEDIA_API_KEY:-}"
CREATOR_ID="${CREATOR_ID:-}"
LIMIT="${LIMIT:-25}"
FORCE="${FORCE:-false}"
ONLY_MISSING_ANALYSIS="${ONLY_MISSING_ANALYSIS:-false}"

if [ -z "$API_KEY" ]; then
  echo "Missing MULTIPLATFORM_MEDIA_API_KEY. Add it to .env or pass it inline."
  exit 1
fi

if [ -z "$CREATOR_ID" ]; then
  echo "Missing CREATOR_ID. Pass it inline when running the script."
  exit 1
fi

offset=0
total_processed=0
total_success=0
total_failed=0

while true; do
  echo "Processing batch: offset=$offset limit=$LIMIT force=$FORCE onlyMissingAnalysis=$ONLY_MISSING_ANALYSIS"

  response="$(
    curl -s "$API_URL" \
      -X POST \
      -H "Content-Type: application/json" \
      -H "x-api-key: $API_KEY" \
      --data "{
        \"creatorId\": \"$CREATOR_ID\",
        \"limit\": $LIMIT,
        \"offset\": $offset,
        \"force\": $FORCE,
        \"onlyMissingAnalysis\": $ONLY_MISSING_ANALYSIS
      }"
  )"

  echo "$response" > "/tmp/recalculate-taxonomy-offset-${offset}.json"

  batch_total="$(echo "$response" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);console.log(j.total ?? 0)})")"
  batch_success="$(echo "$response" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);console.log(j.successCount ?? 0)})")"
  batch_failed="$(echo "$response" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);console.log(j.failureCount ?? 0)})")"

  echo "Batch done: total=$batch_total success=$batch_success failed=$batch_failed"
  echo "Saved response to /tmp/recalculate-taxonomy-offset-${offset}.json"

  total_processed=$((total_processed + batch_total))
  total_success=$((total_success + batch_success))
  total_failed=$((total_failed + batch_failed))

  if [ "$batch_total" -lt "$LIMIT" ]; then
    break
  fi

  offset=$((offset + LIMIT))
done

echo "Done."
echo "Total processed: $total_processed"
echo "Total success: $total_success"
echo "Total failed: $total_failed"
