# Toolbox

- Convention: outils CLI JSON via stdin/stdout.
- Manifest validé par `jarvis/schemas/tool_manifest.schema.json`.
- Sortie standard validée par `jarvis/schemas/tool_output.schema.json`.

## Outils disponibles

- `example_echo`: outil de démonstration minimal.
- `proxmox_ct`: registre SQLite pour cibles Proxmox + mapping `service -> CT` + génération de requête API (`status/start/stop/restart`).
- `npm_service`: registre SQLite pour instances Nginx Proxy Manager et services reverse proxy, avec génération des requêtes API (`list/add/delete`).
- `sensitive_store`: mini coffre SQLite pour stocker les valeurs sensibles (`namespace/key/value`) et les référencer depuis les autres outils.

## Proxmox/NPM et stockage des accès

- DB partagée: `JARVIS_INFRA_DB` (défaut `jarvis/database/db.db`).
- Les outils `proxmox_ct` et `npm_service` supportent deux modes pour le mot de passe:
  - inline (`password`)
  - référence secrète (`password_secret_key`) lue dans `sensitive_store`.

Ce modèle prépare l'étape suivante: exposer une interface web d'édition des valeurs DB sans changer les contrats outillés.

## Flux didactique: payload JSON et lecture DB

### 1) Ce que reçoit `toolbox_runner`

Le endpoint `POST /v1/run` reçoit un payload de ce type:

```json
{
  "tool": "npm_service",
  "input": {
    "action": "list",
    "instance_name": "prod"
  },
  "context": {}
}
```

- `tool`: nom logique de l'outil à exécuter.
- `input`: données métier envoyées au script Python de l'outil.
- `context`: réservé pour l'orchestration (non utilisé directement par les scripts actuels).

### 2) Comment l'outil est trouvé

1. `toolbox_runner` scanne `jarvis/toolbox/tools/*/manifest.json`.
2. Chaque manifest indique l'`entrypoint` (ex: `tool.py`).
3. Le runner exécute ensuite `python <entrypoint>` en lui passant `input` sur `stdin`.

### 3) Où et comment la DB est lue

- La lecture DB **ne se fait pas dans `llm_adapter`**.
- Elle se fait **dans le script outil** (`jarvis/toolbox/tools/<tool>/tool.py`) au moment de l'exécution.
- Le chemin DB est lu depuis la variable `JARVIS_INFRA_DB` (ou la valeur par défaut du tool).

Exemple conceptuel:

1. Le LLM décide d'appeler `npm_service`.
2. Node-RED envoie `POST /v1/run` avec `tool="npm_service"` et `input`.
3. `toolbox_runner` lance `jarvis/toolbox/tools/npm_service/tool.py`.
4. Le script ouvre SQLite, lit les lignes nécessaires, puis retourne du JSON.
5. `toolbox_runner` valide la sortie et renvoie la réponse finale.

### 4) Règle simple à retenir

- Le LLM prépare l'intention et le payload.
- `toolbox_runner` exécute.
- Le script `tool.py` fait l'accès DB réel.
