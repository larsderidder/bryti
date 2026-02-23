#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

RESTART_DELAY_SECONDS="${RESTART_DELAY_SECONDS:-2}"

while true; do
  echo "Building TypeScript..."
  npm run build

  exit_code=0
  node dist/index.js || exit_code=$?

  if [ "$exit_code" -eq 0 ]; then
    echo "Bryti stopped cleanly."
    exit 0
  fi

  if [ "$exit_code" -eq 42 ]; then
    echo "Bryti restart requested. Rebuilding and restarting..."
    continue
  fi

  echo "Bryti crashed (exit code $exit_code). Restarting in ${RESTART_DELAY_SECONDS}s..."
  sleep "$RESTART_DELAY_SECONDS"
done
