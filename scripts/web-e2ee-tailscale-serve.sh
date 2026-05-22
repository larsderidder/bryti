#!/usr/bin/env bash
set -euo pipefail

PORT="${1:-${WEB_E2EE_PORT:-8787}}"

if ! command -v tailscale >/dev/null 2>&1; then
  echo "Error: tailscale is not installed or not on PATH." >&2
  echo "Install Tailscale first, then rerun this helper." >&2
  exit 1
fi

case "$PORT" in
  ''|*[!0-9]*)
    echo "Error: port must be a number. Got: $PORT" >&2
    exit 1
    ;;
esac

cat <<EOF
Starting Tailscale Serve for web_e2ee on local port $PORT.

This helper only runs: tailscale serve $PORT
- Start Bryti separately.
- Open the HTTPS URL printed by Tailscale Serve.
- Do not open https://...:$PORT
- If Bryti config changed, restart Bryti before testing.
EOF

exec tailscale serve "$PORT"
