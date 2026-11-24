#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "[Error] Node.js (>= 20) is required. Please install it first: https://nodejs.org/" >&2
  exit 1
fi

exec node "${SCRIPT_DIR}/setup.mjs" "$@"
