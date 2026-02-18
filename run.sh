#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

# Build if dist is missing or source files are newer than the compiled output.
if [ ! -f dist/index.js ] || find src -type f \( -name '*.ts' -o -name '*.tsx' \) -newer dist/index.js | grep -q .; then
  echo "Building TypeScript..."
  npm run build
fi

# Auto-restart on crashes (non-zero exit). Clean exits do not restart.
RESTART_DELAY_SECONDS="${RESTART_DELAY_SECONDS:-2}"

while true; do
  node --env-file=.env dist/index.js
  exit_code=$?

  if [ "$exit_code" -eq 0 ]; then
    exit 0
  fi

  echo "Pibot crashed (exit code $exit_code). Restarting in ${RESTART_DELAY_SECONDS}s..."
  sleep "$RESTART_DELAY_SECONDS"
done
