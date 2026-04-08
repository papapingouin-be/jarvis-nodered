#!/usr/bin/env bash
set -euo pipefail

NODERED_URL="${NODERED_URL:-http://localhost:1880}"
FLOW_FILE="${FLOW_FILE:-jarvis/flows/nodered/exports/jarvis-v1.flows.json}"
TOKEN="${NODERED_TOKEN:-}"

headers=(-H "Content-Type: application/json" -H "Node-RED-Deployment-Type: full")
if [[ -n "$TOKEN" ]]; then
  headers+=(-H "Authorization: Bearer $TOKEN")
fi

curl -sS -X POST "${NODERED_URL}/flows" "${headers[@]}" --data-binary "@${FLOW_FILE}"
echo "\nFlows déployés vers ${NODERED_URL}."
