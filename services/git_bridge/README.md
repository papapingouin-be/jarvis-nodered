# git_bridge

Bridge Git minimal avec support `DRY_RUN`.

## Lancer en local (sans Docker)

L'erreur `ModuleNotFoundError: No module named 'services.git_bridge'` arrive en général quand le répertoire racine du repo n'est pas dans `PYTHONPATH`.

Utilise ce lanceur (depuis n'importe quel dossier) :

```bash
./services/git_bridge/run_local.sh
```

Ce script :

- détecte automatiquement la racine du repo,
- exporte `PYTHONPATH=<repo_root>`
- puis lance `uvicorn services.git_bridge.app:app`.

## Lancer manuellement

Si tu préfères une commande directe :

```bash
PYTHONPATH=$(pwd) uvicorn services.git_bridge.app:app --host 0.0.0.0 --port 8040
```

(à exécuter depuis la racine du repository)
