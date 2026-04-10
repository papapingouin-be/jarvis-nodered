# toolbox_runner

Service d'exécution des outils CLI JSON-in/JSON-out.

## Tests (dans le conteneur toolbox_runner)

Si vous lancez les tests depuis le conteneur `toolbox_runner`, utilisez :

```bash
python -m pytest -q tests/test_schemas.py services/toolbox_runner/tests/test_run_example_echo.py services/toolbox_runner/tests/test_registry.py
```

`pytest` est inclus dans `services/toolbox_runner/requirements.txt` pour permettre cette exécution directement dans le conteneur.
