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

- DB partagée:
  - `JARVIS_INFRA_DB` pour imposer le chemin complet du fichier SQLite.
  - `JARVIS_INFRA_DB_DIR` pour imposer seulement le dossier (fichier `jarvis.db`).
  - Défaut: `/opt/jarvis/database/jarvis.db` si ce dossier existe, sinon `jarvis/database/jarvis.db` dans le repo.
- Les outils `proxmox_ct` et `npm_service` supportent deux modes pour le mot de passe:
  - inline (`password`)
  - référence secrète (`password_secret_key`) lue dans `sensitive_store`.
- Pour `npm_service/register_instance`, il faut **exactement un** des deux champs:
  - `instance.password` (mot de passe en clair), ou
  - `instance.password_secret_key` (clé vers `sensitive_values` namespace `npm`).
  - Si les deux sont absents (ou vides) ou si les deux sont fournis, l'outil renvoie une erreur de validation.

### Cas fréquent de confusion: `npm_service.*` vs `instance.password*`

Tu peux utiliser `npm_service` de deux façons différentes:

1. **Mode fallback config-web (sans `register_instance`)**
   - L'outil lit dans `sensitive_values`:
     - `namespace='npm_service', key='NPM_URL'`
     - `namespace='npm_service', key='NPM_IDENTITY'`
     - `namespace='npm_service', key='NPM_SECRET'`
   - (compatibilité legacy: namespace `npm` aussi accepté pour ces 3 clés).
   - Dans ce mode, il est normal de **ne pas voir** `instance.password` ni `instance.password_secret_key`.

2. **Mode instance enregistrée (`register_instance`)**
   - Tu enregistres une entrée `npm_instances` avec:
     - soit `instance.password` (secret stocké en clair dans `npm_instances.password`),
     - soit `instance.password_secret_key` (référence vers `sensitive_values(namespace='npm', key=<ta_clé>)`).
   - Ici, `password_secret_key` ne pointe **pas** vers `NPM_SECRET`, mais vers une clé libre que tu choisis dans le namespace `npm` (ex: `npm-admin-pass`).

Ce modèle prépare l'étape suivante: exposer une interface web d'édition des valeurs DB sans changer les contrats outillés.

## Contrat harmonisé pour exposition LLM

- Tous les outils d'infra exposent désormais **un seul champ de routage**: `intent`.
- Les anciennes clés `operation`/`mode` restent tolérées en compatibilité interne, mais ne doivent plus être proposées.
- Intents normalisés utiles pour l'orchestration LLM:
  - Proxmox CT: `list.containers`
  - NPM: `list.services`

Exemples:

```json
{
  "tool": "proxmox_ct",
  "input": {
    "intent": "list.containers",
    "ssh_target": "root@proxmox-host"
  }
}
```

```json
{
  "tool": "npm_service",
  "input": {
    "intent": "list.services",
    "instance_name": "prod"
  }
}
```

## Flux didactique: payload JSON et lecture DB

## OpenWebUI: commandes texte reconnues (Node-RED V1)

Pour déclencher l'outil `npm_service` depuis OpenWebUI avec le flow actuel, utilise une phrase qui matche la détection d'intention, par exemple:

- `liste les services de nginx proxy manager`
- `liste les services de npm`
- `liste les proxy de npm`

Ensuite le flow:
- détecte l'intention `npm_list_services`,
- route vers l'outil `npm_service`,
- envoie au runner un payload avec `input.operation = "list_services"` et `input.instance_name = <NPM_INSTANCE_NAME|default>`.

Si OpenWebUI répond avec une intention inconnue, commence par tester:

- `ping jarvis` (healthcheck sans outil),
- puis `liste les services de nginx proxy manager`.

### 1) Ce que reçoit `toolbox_runner`

Le endpoint `POST /v1/run` reçoit un payload de ce type:

```json
{
  "tool": "npm_service",
  "input": {
    "intent": "list.services",
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
