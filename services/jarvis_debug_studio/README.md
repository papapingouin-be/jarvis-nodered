# Jarvis Debug Studio

Version control-tower : l'écran n'attend plus passivement des traces. Il montre aussi l'état des services et permet de déclencher un test manuel de `npm_service`.

## Endpoints

- `GET /health`
- `GET /api/services` : probe les services Jarvis déclarés.
- `GET /api/tools` : lit les outils exposés par `toolbox_runner`.
- `POST /api/probes/npm_service/list` : appelle `toolbox_runner /v1/run` avec `npm_service` et crée une trace.
- `POST /api/trace/event` : reçoit les événements métier.
- `GET /api/traces`
- `GET /api/traces/{trace_id}`
- `GET /api/live` : SSE.

## Variables utiles

```env
TOOLBOX_RUNNER_URL=http://toolbox_runner:8030
JARVIS_DEBUG_DB=/opt/jarvis/database/jarvis_debug_studio.sqlite
JARVIS_DEBUG_PROBE_TIMEOUT=1.3
JARVIS_DEBUG_MANUAL_PROBE_TIMEOUT=12
```

Côté `toolbox_runner` :

```env
TRACE_ENABLED=true
TRACE_GATEWAY_URL=http://jarvis_debug_studio:4318
TRACE_CODE_PREVIEW=true
TRACE_MAX_CODE_LINES=160
```

## Test manuel

Ouvre `http://<serveur>:4318`, vérifie les cartes de services, puis clique sur **Tester npm_service**.

Ou :

```bash
curl -X POST http://192.168.11.206:4318/api/probes/npm_service/list \
  -H "Content-Type: application/json" \
  -d '{"intent":"list.services"}'
```

Ensuite la trace apparaît dans l'interface avec entrée, sortie, code, logs, erreurs et metadata.
