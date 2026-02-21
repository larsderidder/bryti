#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

# Always rebuild so the running binary is never stale.
echo "Building TypeScript..."
npm run build

# Auto-restart on crashes (non-zero exit). Clean exits do not restart.
RESTART_DELAY_SECONDS="${RESTART_DELAY_SECONDS:-2}"

while true; do
  node --env-file=.env dist/index.js
  exit_code=$?

  if [ "$exit_code" -eq 0 ]; then
    exit 0
  fi

  echo "Bryti crashed (exit code $exit_code). Restarting in ${RESTART_DELAY_SECONDS}s..."
  sleep "$RESTART_DELAY_SECONDS"
done
