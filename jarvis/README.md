# Jarvis V1

## Démarrage rapide

```bash
cp jarvis/.env.example .env
docker compose -f compose.jarvis.yml up -d --build
```

## Node-RED flows

- Import UI: `jarvis/flows/nodered/exports/jarvis-v1.flows.json`
- API: `jarvis/scripts/nodered/deploy_flows_via_api.sh`

## Smoke tests

```bash
jarvis/scripts/dev/smoke.sh
```

## CI locale

```bash
jarvis/ci/check.sh
jarvis/ci/test.sh
```

## GitHub/Gitea CI

Exécuter les mêmes commandes (`check.sh` puis `test.sh`) dans le pipeline.
