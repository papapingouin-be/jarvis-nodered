# config-web corrected v4

Correctif principal :
- fallback automatique du fichier SQLite vers un emplacement inscriptible
- priorité : `DEVLAB_DB_PATH`, puis `./devlab.db`, puis `/tmp/jarvis_devlab.db`

Si ton dossier web n'est pas inscriptible, cette version évite le 500 sur `get_service`.

Conseil :
- remplace les 4 fichiers
- fais un Ctrl+F5
- vérifie dans l'UI la ligne `DB ... writable oui/non`


## V5 debug

Cette version ajoute:
- `action=ping`
- `action=healthcheck` sans ouverture forcée de SQLite
- `action=debug_env`
- affichage détaillé côté `app.js`: message, fichier, ligne

Si ça casse encore, la console du navigateur doit maintenant afficher par exemple:
`php_error — <message> @ /chemin/api.php:123`
