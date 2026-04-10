#!/usr/bin/env bash
set -euo pipefail

if command -v pytest >/dev/null 2>&1; then
  pytest -q
else
  python3 -m pytest -q
fi
