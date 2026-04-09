# Jarvis V1

## Démarrage rapide

```bash
cp jarvis/.env.example .env
docker compose -f compose.jarvis.yml up -d --build
```

## Déploiement Portainer (Stack + env)

Si tu déploies via Portainer, utilise des chemins **absolus** pour les volumes host:

```bash
cp jarvis/.env.portainer.example .env
```

Puis adapte:
- `JARVIS_HOST_ROOT` vers le chemin réel du repo sur l’hôte Docker
- `NODERED_DATA_PATH` et `JARVIS_LOGS_PATH` vers des dossiers persistants

Ensuite, dans Portainer:
1. Stacks > Add stack
2. Colle le contenu de `jarvis/portainer/stack.web-editor.yml` (spécial Web Editor)
3. Renseigne les variables d’environnement du `.env`
4. Deploy the stack

Variables minimales à définir dans Portainer:
- `JARVIS_HOST_ROOT` (ex: `/srv/jarvis-nodered`)
- `NODERED_DATA_PATH` (ex: `/srv/jarvis-nodered/.data/nodered`)
- `JARVIS_LOGS_PATH` (ex: `/srv/jarvis-nodered/.data/logs`)

### Message Portainer: “Control over this stack is limited”

Ce message apparaît généralement quand la stack n’a pas été créée/prise en charge directement par Portainer.
Pour garder le contrôle complet, redéploie la stack depuis l’UI Portainer (Add stack) avec ce compose et ses variables.

## Stack logs / observabilité (Loki + Promtail + Grafana)

Le fichier `docker-compose.observability.yml` est aligné pour un usage Portainer avec:
- `jarvis_loki`
- `jarvis_promtail`
- `jarvis_grafana`

Réseaux externes attendus:
- `jarvis_net` (ou `JARVIS_OBS_NET`)
- `jarvis_proxy` (ou `JARVIS_PROXY_NET`)

Variables utiles (dans Portainer Environment variables):
- `LOKI_CONFIG_PATH`
- `PROMTAIL_CONFIG_PATH`
- `LOKI_PORT`
- `GRAFANA_PORT`
- `GF_SECURITY_ADMIN_USER`
- `GF_SECURITY_ADMIN_PASSWORD`

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
