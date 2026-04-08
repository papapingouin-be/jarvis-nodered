#!/usr/bin/env bash
set -euo pipefail

curl -fsS http://localhost:8010/health
curl -fsS http://localhost:8020/health
curl -fsS http://localhost:8030/health
curl -fsS http://localhost:8040/health
curl -fsS http://localhost:8050/health

curl -fsS -X POST http://localhost:8010/v1/classify -H 'Content-Type: application/json' -d '{"channel":"openwebui","user_id":"laurent","conversation_id":"c1","message_id":"m1","text":"Créer un projet outil","attachments":[],"timestamp":"2026-04-08T12:00:00Z","reply_policy":"same_channel","meta":{}}'

curl -fsS -X POST http://localhost:8030/v1/run -H 'Content-Type: application/json' -d '{"tool":"example_echo","input":{"message":"hello"},"context":{}}'

echo "Smoke tests OK"
