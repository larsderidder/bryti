#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

RESTART_DELAY_SECONDS="${BRYTI_RESTART_DELAY_MS:-2000}"
RESTART_DELAY_SECONDS=$((RESTART_DELAY_SECONDS / 1000))

# Use tsx for dev (no build step), fall back to tsc + node for production.
if [ "${BRYTI_MODE:-dev}" != "prod" ] && npx tsx --version &>/dev/null; then
  RUN_CMD="npx tsx src/cli.ts serve"
else
  RUN_CMD="node dist/cli.js serve"
fi

while true; do
  if [[ "$RUN_CMD" == node* ]]; then
    echo "Building TypeScript..."
    npm run build
  fi

  exit_code=0
  $RUN_CMD || exit_code=$?

  if [ "$exit_code" -eq 0 ]; then
    echo "Bryti stopped cleanly."
    exit 0
  fi

  if [ "$exit_code" -eq 42 ]; then
    echo "Bryti restart requested. Restarting..."
    continue
  fi

  echo "Bryti crashed (exit code $exit_code). Restarting in ${RESTART_DELAY_SECONDS}s..."
  sleep "$RESTART_DELAY_SECONDS"
done
