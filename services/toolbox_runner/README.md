# toolbox_runner

Service d'exécution des outils CLI JSON-in/JSON-out.

## Endpoints

- `GET /health` : healthcheck.
- `GET /v1/tools` : liste des outils disponibles dans le registre chargé.
- `POST /v1/run` : exécute un outil (`tool` requis dans le payload).
- `POST /v1/run/{tool}` : exécute un outil en passant l'input directement dans le body JSON.
- Compatibilité: `POST /run` et `POST /run/{tool}` (alias des endpoints `/v1/*`).

## CORS (OpenWebUI mode utilisateur)

Le service active CORS pour permettre les appels depuis le navigateur (mode connexion
utilisateur dans OpenWebUI). Les requêtes `OPTIONS` (preflight) sont acceptées.

- Variable: `TOOLBOX_CORS_ALLOW_ORIGINS`
- Valeur par défaut: `*`
- Format: liste d'origines séparées par des virgules

Exemple :

```bash
TOOLBOX_CORS_ALLOW_ORIGINS="http://openwebui.jarvis.papapingouinbe.duckdns.org,https://openwebui.jarvis.papapingouinbe.duckdns.org"
```

Si `tool` est manquant dans `POST /v1/run`, le service renvoie une erreur `422`
avec une charge utile qui inclut les outils disponibles et un exemple de payload.

Si un outil écrit sur `stderr` tout en renvoyant un JSON valide sur `stdout`,
ces lignes sont propagées dans `logs` côté réponse et un événement
`tool_execute_stderr` est aussi émis dans les logs du runner.

## Logging / debug

- `LOG_LEVEL` (défaut `INFO`) : niveau global des logs Python (`DEBUG`, `INFO`, ...).
- `TOOLBOX_LOG_EXCLUDE_PATHS` : chemins HTTP à ignorer dans les traces du middleware
  (défaut `/openapi.json,/docs,/docs/oauth2-redirect`), utile pour réduire le bruit
  lié aux préflights CORS et au chargement Swagger/OpenAPI.
- `NPM_SERVICE_DEBUG` (`1|true|yes|on`) : active des logs détaillés du tool
  `npm_service` (résolution des credentials, URLs appelées, compteurs remote/local)
  via `stderr`, ensuite visibles dans `output.logs` via `toolbox_runner`.

## Exemple `npm_service`

Le tool `npm_service` exige aussi `input.intent` (champ requis par son schéma).

Pour lister les services d'une instance NPM, utilisez par exemple :

```json
{
  "tool": "npm_service",
  "input": {
    "intent": "list.services",
    "instance_name": "default"
  }
}
```

Alias également acceptés pour cette action : `list_services`, `list_proxy_services`,
`lister les services npm`.

## Tests (dans le conteneur toolbox_runner)

Si vous lancez les tests depuis le conteneur `toolbox_runner`, utilisez :

```bash
python -m pytest -q tests/test_schemas.py services/toolbox_runner/tests/test_run_example_echo.py services/toolbox_runner/tests/test_registry.py
```

`pytest` est inclus dans `services/toolbox_runner/requirements.txt` pour permettre cette exécution directement dans le conteneur.
