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
