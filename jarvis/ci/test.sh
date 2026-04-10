#!/usr/bin/env bash
set -euo pipefail

python -m pip install --disable-pip-version-check --no-cache-dir pytest
python -m pytest -q "$@"
