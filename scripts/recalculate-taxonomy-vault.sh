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

SOURCE="${SOURCE:-telegram}"
CREATOR_ID="${CREATOR_ID:-}"
SESSION_NAME="${SESSION_NAME:-}"
OF_CREATOR_ID="${OF_CREATOR_ID:-}"

LIMIT="${LIMIT:-25}"
FORCE="${FORCE:-false}"
ONLY_MISSING_ANALYSIS="${ONLY_MISSING_ANALYSIS:-false}"
CALCULATE_DESCRIPTION="${CALCULATE_DESCRIPTION:-true}"

if [ -z "$API_KEY" ]; then
  echo "Missing MULTIPLATFORM_MEDIA_API_KEY. Add it to .env or pass it inline."
  exit 1
fi

if [ "$SOURCE" = "onlyfans" ]; then
  if [ -z "$SESSION_NAME" ]; then
    echo "Missing SESSION_NAME for OnlyFans. Pass it inline when running the script."
    exit 1
  fi

  if [ -z "$OF_CREATOR_ID" ]; then
    echo "Missing OF_CREATOR_ID for OnlyFans. Pass it inline when running the script."
    exit 1
  fi
else
  if [ -z "$CREATOR_ID" ]; then
    echo "Missing CREATOR_ID for Telegram. Pass it inline when running the script."
    exit 1
  fi
fi

json_get_number() {
  local key="$1"
  local fallback="$2"

  node -e "
    let d='';
    process.stdin.on('data', c => d += c);
    process.stdin.on('end', () => {
      try {
        const j = JSON.parse(d);
        const value = Number(j['$key']);
        console.log(Number.isFinite(value) ? value : $fallback);
      } catch {
        console.log($fallback);
      }
    });
  "
}

offset=0
total_scanned=0
total_processed=0
total_success=0
total_failed=0
request_failed_count=0

while true; do
  echo "Processing batch: offset=$offset limit=$LIMIT source=$SOURCE force=$FORCE onlyMissingAnalysis=$ONLY_MISSING_ANALYSIS calculateDescription=$CALCULATE_DESCRIPTION"

  response="$(
    curl -sS "$API_URL" \
      -X POST \
      -H "Content-Type: application/json" \
      -H "x-api-key: $API_KEY" \
      --data "{
        \"source\": \"$SOURCE\",
        \"creatorId\": \"$CREATOR_ID\",
        \"sessionName\": \"$SESSION_NAME\",
        \"ofCreatorId\": \"$OF_CREATOR_ID\",
        \"limit\": $LIMIT,
        \"offset\": $offset,
        \"force\": $FORCE,
        \"onlyMissingAnalysis\": $ONLY_MISSING_ANALYSIS,
        \"calculateDescription\": $CALCULATE_DESCRIPTION
      }" || true
  )"

  output_file="/tmp/recalculate-taxonomy-${SOURCE}-${SESSION_NAME:-$CREATOR_ID}-offset-${offset}.json"
  echo "$response" > "$output_file"

  batch_total="$(echo "$response" | json_get_number "total" 0)"
  batch_success="$(echo "$response" | json_get_number "successCount" 0)"
  batch_failed="$(echo "$response" | json_get_number "failureCount" 0)"

  # scannedCount means rows checked before onlyMissingAnalysis filtering.
  # If endpoint does not return it yet, fallback to batch_total.
  batch_scanned="$(echo "$response" | json_get_number "scannedCount" "$batch_total")"

  echo "Batch done: scanned=$batch_scanned processed=$batch_total success=$batch_success failed=$batch_failed"
  echo "Saved response to $output_file"

  total_scanned=$((total_scanned + batch_scanned))
  total_processed=$((total_processed + batch_total))
  total_success=$((total_success + batch_success))
  total_failed=$((total_failed + batch_failed))

  if [ "$batch_scanned" -eq 0 ]; then
    break
  fi

  if [ "$batch_scanned" -lt "$LIMIT" ]; then
    break
  fi

  offset=$((offset + LIMIT))
done

echo "Done."
echo "Total scanned: $total_scanned"
echo "Total processed: $total_processed"
echo "Total success: $total_success"
echo "Total failed: $total_failed"
