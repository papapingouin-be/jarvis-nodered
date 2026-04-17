# toolbox_runner

Service d'exécution des outils CLI JSON-in/JSON-out.

## Endpoints

- `GET /health` : healthcheck.
- `GET /v1/tools` : liste des outils disponibles dans le registre chargé.
- `POST /v1/run` : exécute un outil (`tool` requis dans le payload).

Si `tool` est manquant dans `POST /v1/run`, le service renvoie une erreur `422`
avec une charge utile qui inclut les outils disponibles et un exemple de payload.

## Tests (dans le conteneur toolbox_runner)

Si vous lancez les tests depuis le conteneur `toolbox_runner`, utilisez :

```bash
python -m pytest -q tests/test_schemas.py services/toolbox_runner/tests/test_run_example_echo.py services/toolbox_runner/tests/test_registry.py
```

`pytest` est inclus dans `services/toolbox_runner/requirements.txt` pour permettre cette exécution directement dans le conteneur.
