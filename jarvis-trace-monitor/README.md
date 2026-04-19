# jarvis-trace-monitor (V1)

Monitor web orienté **trace métier corrélée** pour la chaîne MCP de Jarvis :

`OpenWebUI → MCPO → MCP Server → Tool → Script/DB/API → Réponse`

> Objectif V1: comprendre rapidement un flux, son état, son timing et ses blocages **sans ouvrir les logs système**.

## Fonctionnalités livrées

- Ingestion d'événements structurés via `POST /api/events`.
- Compatibilité OTLP/HTTP JSON basique via `POST /v1/traces` (conversion automatique en événements monitorables).
- Corrélation par `trace_id` et reconstruction de flux.
- Vue **Live** des flux récents/en cours avec filtres (statut/service/tool/texte).
- Vue **Trace détaillée** cliquable (style run n8n simplifié).
- Vue **Waterfall timing** (inspirée Chrome Network).
- Vue **Services** (health synthétique + activité récente).
- Interprétation sémantique simple (insights exploitables).
- Mode live avec **SSE** (`GET /api/stream`).
- Dataset de démonstration + simulateur live.

## Stack technique

- Backend: Node.js + Express
- Stockage: SQLite (via `better-sqlite3`)
- Frontend: HTML/CSS/JS vanilla

## Arborescence

```text
jarvis-trace-monitor/
├── package.json
├── README.md
├── data/                       # base SQLite générée au runtime
├── src/
│   ├── db.js                   # init DB SQLite + schéma
│   ├── schema.js               # validation événement
│   ├── traceService.js         # corrélation, timeline, waterfall, services
│   └── server.js               # API HTTP + SSE + static web
├── public/
│   ├── index.html              # UI
│   ├── styles.css              # style sobre / technique
│   └── app.js                  # logique front (live + vues)
└── scripts/
    ├── seed-events.json        # données réalistes de démo
    ├── seed.js                 # injection dataset
    └── simulate.js             # émission live d'une trace
```

## Modèle d'événement

Exemple JSON accepté:

```json
{
  "ts": "2026-04-19T14:20:11.120Z",
  "service": "mcpo",
  "level": "info",
  "trace_id": "conv-1775899625469",
  "span_id": "step-03",
  "parent_span_id": "step-02",
  "event": "tool_invocation_started",
  "stage": "tool_execution",
  "tool": "npm_service",
  "intent": "diagnostic",
  "status": "running",
  "summary": "Lancement du tool npm_service",
  "details": {
    "command": "list"
  }
}
```

Champs minimaux validés:
- `ts`
- `service`
- `trace_id`
- `event`
- `summary`

Types d'événements V1 pris en charge (extensible):
- `flow_received`
- `routing_started`
- `routing_finished`
- `tool_lookup_started`
- `tool_lookup_failed`
- `tool_invocation_started`
- `tool_invocation_finished`
- `script_started`
- `script_stdout`
- `script_stderr`
- `db_query_started`
- `db_query_finished`
- `api_call_started`
- `api_call_finished`
- `validation_error`
- `timeout`
- `flow_completed`
- `heartbeat`

## API

- `POST /api/events`
- `POST /v1/traces` (OTLP/HTTP JSON minimal)
- `GET /api/flows`
- `GET /api/flows/:traceId`
- `GET /api/flows/:traceId/timeline`
- `GET /api/flows/:traceId/waterfall`
- `GET /api/services`
- `GET /api/events/recent`
- `GET /api/stream` (SSE)

## Lancement local

```bash
cd jarvis-trace-monitor
npm install
npm run seed
npm start
```

Puis ouvrir: <http://localhost:4318>

## Démo rapide

1. Charger les données démo:
```bash
npm run seed
```

2. Simuler une nouvelle trace live (SSE):
```bash
npm run simulate
```

3. Injection manuelle:
```bash
curl -X POST http://localhost:4318/api/events \
  -H 'Content-Type: application/json' \
  -d '{
    "ts":"2026-04-19T14:20:11.120Z",
    "service":"mcpo",
    "trace_id":"conv-manual-001",
    "event":"flow_received",
    "summary":"Test manuel"
  }'
```

## Sémantique métier (insights)

La couche d'interprétation calcule des messages utiles par trace, par exemple:
- "Le flux a bien atteint MCPO puis le MCP Server"
- "Le tool a démarré mais aucune fin n’a été reçue"
- "Une erreur de validation est survenue avant exécution"
- "Le flux semble bloqué entre la sélection du tool et son exécution"
- "Le flux est silencieux depuis X secondes"

## Notes V1

- V1 privilégie la lisibilité opérationnelle et la simplicité de déploiement.
- Le waterfall repose sur les timestamps d'événements corrélés (`span_id` quand disponible).
- L'état de service (`healthy/warning/silent/error`) est estimé avec règles simples sur activité récente, erreurs et latence.

## Dépannage rapide

### Cas: OpenWebUI affiche `TOOL_RESULT_RAW`, mais le moniteur reste vide

Si OpenWebUI affiche un résultat brut de tool comme:

```text
TOOL_RESULT_RAW:
{"tools":["example_echo","http_probe", ...]}
```

et qu'aucune trace n'apparaît dans le monitor, c'est généralement normal: ce payload n'est **pas** un événement de trace.

Le monitor n'affiche que des objets envoyés à `POST /api/events` avec au minimum:

- `ts`
- `service`
- `trace_id`
- `event`
- `summary`

Exemple d'adaptation minimale côté intégration:

```bash
curl -X POST http://localhost:4318/api/events \
  -H 'Content-Type: application/json' \
  -d '{
    "ts":"2026-04-19T14:20:11.120Z",
    "service":"openwebui",
    "trace_id":"conv-123",
    "event":"tool_invocation_finished",
    "summary":"Liste des tools récupérée",
    "details":{"tools":["example_echo","http_probe"]}
  }'
```

Checklist rapide:
- vérifier que le monitor est joignable (`GET /api/health`);
- vérifier que votre bridge envoie bien vers `POST /api/events` (et non uniquement vers stdout);
- vérifier que `trace_id` est stable pour toute la conversation;
- vérifier que les timestamps (`ts`) sont en ISO-8601 UTC.
