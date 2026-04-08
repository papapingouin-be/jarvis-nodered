#!/usr/bin/env bash
set -euo pipefail
docker compose -f compose.jarvis.yml up -d --build
