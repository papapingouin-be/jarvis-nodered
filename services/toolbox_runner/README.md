# toolbox_runner

Service d'exécution des outils CLI JSON-in/JSON-out.

## Endpoints

- `GET /health` : healthcheck.
- `GET /v1/tools` : liste des outils disponibles dans le registre chargé.
- `POST /v1/run` : exécute un outil (`tool` requis dans le payload).

Si `tool` est manquant dans `POST /v1/run`, le service renvoie une erreur `422`
avec une charge utile qui inclut les outils disponibles et un exemple de payload.

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
