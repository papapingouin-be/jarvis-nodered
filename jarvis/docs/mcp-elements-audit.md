# Audit éléments MCP et versions

Date de vérification: 2026-04-10

## Résultat

Tous les services MCP exposés dans `services/` disposent:
- d'une documentation locale (`README.md`)
- d'un numéro de version FastAPI (`version="1.0"`)

| Élément | README | Version | Doc MCP (FastAPI docs) |
|---|---|---|---|
| `git_bridge` | ✅ | `1.0` | ✅ |
| `llm_adapter` | ✅ | `1.0` | ✅ |
| `log_bridge` | ✅ | `1.0` | ✅ |
| `openproject_adapter` | ✅ | `1.0` | ✅ |
| `toolbox_runner` | ✅ | `1.0` | ✅ |

## Méthode

Contrôle effectué en lisant les dossiers `services/*` et en vérifiant dans chaque `app.py` la présence de `FastAPI(..., version=...)`.
