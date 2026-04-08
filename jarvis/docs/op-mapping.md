# Mapping OpenProject

## Hypothèses V1

- Les IDs `customFieldN` sont découverts hors service et passés via `OP_CUSTOM_FIELD_MAP_JSON` ou payload.
- TODO: brancher la découverte automatique via Forms API OpenProject quand l'instance cible est disponible.

| Nom | Type OpenProject recommandé | Valeurs possibles | Utilité Jarvis |
|-----|-----------------------------|------------------|----------------|
| jarvis_action_type | Liste (single select) | create_tool, dev_app, dev_database, pedagogical_content, run_tool, analysis | Classe l’intention d’exécution |
| jarvis_executor | Liste | jarvis, human, mixed | Qui exécute |
| jarvis_status | Liste | draft, ready, running, blocked, waiting_human, done, failed | Machine d’état Jarvis |
| jarvis_tool_needed | Texte | libre | Nom outil toolbox si imposé |

Champ optionnel: `jarvis_error_code` (texte) si besoin de diagnostic.
