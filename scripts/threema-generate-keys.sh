#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
THREEMA_DIR="${ROOT_DIR}/data/private/threema"
VENV_DIR="${THREEMA_DIR}/venv"
PRIVATE_KEY_PATH="${THREEMA_DIR}/privateKey.txt"
PUBLIC_KEY_PATH="${THREEMA_DIR}/publicKey.txt"
FORCE=0

usage() {
  cat <<'EOF'
Usage: bash scripts/threema-generate-keys.sh [--force]

Local-only helper for preparing Threema Gateway E2E keys for Bryti.

What it does:
- creates data/private/threema/
- creates or reuses a Python virtual environment in data/private/threema/venv
- installs the official Python package: threema.gateway
- generates privateKey.txt and publicKey.txt locally

Safety:
- refuses to overwrite existing key files unless --force is provided
- prints only file paths and next steps
- does not send messages
- does not require a real Gateway ID or API secret

Generated files:
- data/private/threema/privateKey.txt
- data/private/threema/publicKey.txt

EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --force)
      FORCE=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

if [ -f "${PRIVATE_KEY_PATH}" ] || [ -f "${PUBLIC_KEY_PATH}" ]; then
  if [ "${FORCE}" -ne 1 ]; then
    echo "Refusing to overwrite existing key files." >&2
    echo "Existing paths:" >&2
    [ -f "${PRIVATE_KEY_PATH}" ] && echo "- ${PRIVATE_KEY_PATH}" >&2
    [ -f "${PUBLIC_KEY_PATH}" ] && echo "- ${PUBLIC_KEY_PATH}" >&2
    echo "Re-run with --force to replace them." >&2
    exit 1
  fi
fi

mkdir -p "${THREEMA_DIR}"

PYTHON_BIN=""
if command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="$(command -v python3)"
elif command -v python >/dev/null 2>&1; then
  PYTHON_BIN="$(command -v python)"
else
  echo "Python not found. Install Python 3 first." >&2
  exit 1
fi

if [ ! -d "${VENV_DIR}" ]; then
  "${PYTHON_BIN}" -m venv "${VENV_DIR}"
fi

# shellcheck disable=SC1091
. "${VENV_DIR}/bin/activate"

python -m pip install --upgrade pip >/dev/null
python -m pip install --upgrade threema.gateway >/dev/null

if [ "${FORCE}" -eq 1 ]; then
  rm -f "${PRIVATE_KEY_PATH}" "${PUBLIC_KEY_PATH}"
fi

threema-gateway generate "${PRIVATE_KEY_PATH}" "${PUBLIC_KEY_PATH}"

cat <<EOF
Threema Gateway keypair generated locally.

Paths:
- private key: ${PRIVATE_KEY_PATH}
- public key:  ${PUBLIC_KEY_PATH}
- venv:        ${VENV_DIR}

Next steps:
1. Back up the private key securely.
2. Keep privateKey.txt local. Do not commit it.
3. Paste only publicKey.txt into the Threema Gateway admin when requesting an E2E Gateway ID.
4. After the Gateway ID is approved, obtain the API secret from the Threema Gateway admin.
5. Configure Bryti with placeholder-based local settings only.

Warnings:
- Do not paste the private key into chat, GitHub, logs, or PRs.
- Do not store a real API secret in committed files.
- Losing the private key makes the E2E Gateway ID unusable.
EOF
