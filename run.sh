#!/usr/bin/env bash
set -u

cd "$(dirname "$0")"

# Auto-restart on crashes (non-zero exit). Clean exits stop the loop.
RESTART_DELAY_SECONDS="${RESTART_DELAY_SECONDS:-2}"

while true; do
  node --env-file=.env dist/index.js
  exit_code=$?

  if [ "$exit_code" -eq 0 ]; then
    echo "Pibot exited cleanly. Not restarting."
    exit 0
  fi

  echo "Pibot crashed with exit code ${exit_code}. Restarting in ${RESTART_DELAY_SECONDS}s..."
  sleep "$RESTART_DELAY_SECONDS"
done
