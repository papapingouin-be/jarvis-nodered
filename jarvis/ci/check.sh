#!/usr/bin/env bash
set -euo pipefail
python -m ruff check .
python - <<'PY'
from services.common.jsonschema_utils import validate_payload
validate_payload('jarvis_message.schema.json', {
    'channel':'openwebui','user_id':'u','conversation_id':'c','message_id':'m','text':'x','attachments':[],
    'timestamp':'2026-04-08T12:00:00Z','reply_policy':'same_channel','meta':{}
})
print('Schema validation smoke OK')
PY
