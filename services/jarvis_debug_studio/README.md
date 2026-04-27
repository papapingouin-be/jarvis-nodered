# Jarvis Debug Studio

Vraie boîte noire d'exécution pour Jarvis MCP.

Ce service ne lit pas les logs Docker. Il reçoit des événements métier depuis `toolbox_runner` et affiche l'exécution complète d'un outil : entrée, validation, handler/fichier exécuté, aperçu du code, stdout, stderr, sortie brute, durée et erreur expliquée.

## Endpoints

- `GET /health`
- `POST /api/trace/event`
- `GET /api/traces`
- `GET /api/traces/{trace_id}`
- `GET /api/live` SSE
- `GET /` interface web

## Test npm_service

```bash
curl -X POST http://192.168.11.206:8030/v1/run \
  -H "Content-Type: application/json" \
  -d '{
    "tool": "npm_service",
    "input": {"intent": "list.services"},
    "context": {"trace_id": "test-npm-001"}
  }'
```

Puis ouvrir :

```text
http://192.168.11.206:4318
```

## Variables utiles

Dans `toolbox_runner` :

```env
TRACE_ENABLED=true
TRACE_GATEWAY_URL=http://jarvis_debug_studio:4318
TRACE_CODE_PREVIEW=true
TRACE_MAX_CODE_LINES=160
TRACE_POST_TIMEOUT_S=0.8
```

Dans `jarvis_debug_studio` :

```env
JARVIS_DEBUG_DB=/opt/jarvis/database/jarvis_debug_studio.sqlite
JARVIS_DEBUG_MAX_CODE_LINES=160
```

## Phases visibles

- `request.received`
- `tool.selected`
- `validation.start`
- `validation.ok` / `validation.error`
- `handler.resolved`
- `code.execution.start`
- `code.execution.stdout`
- `code.execution.stderr`
- `code.execution.result` / `code.execution.error`
- `output.validation.ok` / `output.validation.error`
- `response.returned`

## Sécurité

Les champs contenant `password`, `secret`, `token`, `api_key`, `authorization`, etc. sont masqués automatiquement.
