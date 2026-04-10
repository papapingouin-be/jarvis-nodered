# Toolbox

- Convention: outils CLI JSON via stdin/stdout.
- Manifest validé par `jarvis/schemas/tool_manifest.schema.json`.
- Sortie standard validée par `jarvis/schemas/tool_output.schema.json`.

## Outils disponibles

- `example_echo`: outil de démonstration minimal.
- `proxmox_ct`: registre SQLite pour cibles Proxmox + mapping `service -> CT` avec génération de requête API (`status/start/stop/restart`).

## Proxmox et stockage des accès

`proxmox_ct` stocke `login/password/ip/api_path/node` dans une DB SQLite (`JARVIS_INFRA_DB`, défaut `/tmp/jarvis_infra.db`).

> ⚠️ Le mot de passe est actuellement stocké en clair pour garder un socle simple compatible V1. Prévoir un chiffrement (Vault/SOPS/KMS) avant un usage production.
