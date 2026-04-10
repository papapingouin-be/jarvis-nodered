#!/usr/bin/env bash
set -euo pipefail

# Run from anywhere by resolving repo root from this script location.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

export PYTHONPATH="${REPO_ROOT}:${PYTHONPATH:-}"

exec uvicorn services.git_bridge.app:app --host 0.0.0.0 --port "${PORT:-8040}"
