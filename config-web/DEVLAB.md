# Jarvis DevLab

DevLab transforme `config-web` en atelier de développement pour les tools Jarvis.

## Ce qui est inclus

- Dashboard santé (DB, runner, backend dev)
- Tools Lab
  - exécution directe d'un tool Python
  - exécution via `toolbox_runner`
  - validation de l'input via le manifest
  - trace structurée par étapes
  - diagnostics automatiques
- Flow Lab
  - test du flux Node-RED à partir d'un payload JSON
- Code Lab
  - lecture / édition / sauvegarde de fichiers Python
  - validation syntaxique Python, JSON, JavaScript
- DB Lab
  - édition `sensitive_values`
  - inspection des tables SQLite
- Historique des runs
  - stockage des exécutions dans `devlab_runs`
- LLM Studio
  - explication d'un run via heuristiques locales et `llm_adapter`

## Nouveaux composants

- `config-web/devproxy.php`
- `services/devlab_backend/app.py`
- `services/devlab_backend/requirements.txt`

## Démarrage

Le stack Docker inclut maintenant `devlab_backend` sur le port `8090`.

L'UI passe par `devproxy.php` par défaut, donc il suffit en général de laisser `URL Dev backend = proxy` dans l'interface.

## Modes d'exécution des tools

- `direct` : exécute directement `tool.py`
- `runner` : passe par `toolbox_runner`

## Historique

Le backend crée automatiquement la table SQLite `devlab_runs`.

## Notes

- `flow-test.html` redirige maintenant vers l'onglet **Flow Lab**.
- Le backend DevLab détecte déjà des incohérences classiques comme `/api/api/` dans les URLs NPM.
