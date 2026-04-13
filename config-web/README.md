# config-web corrected zip

Contenu:
- `index.html`
- `app.js`
- `api.php`

## Corrections apportées

- `api.php` renvoie toujours du JSON, même en cas d'erreur PHP
- `app.js` affiche la vraie erreur si la réponse n'est pas du JSON
- ajout d'un `healthcheck`
- historique des runs en SQLite locale `devlab.db`
- UI plus robuste
- lecture/écriture/validation de fichiers code
- fallback sur un service de démonstration si aucun manifest n'est détecté

## Déploiement

Copie les fichiers dans ton dossier web `config-web`, en remplaçant les anciens.

## Vérification rapide

Ouvre directement:
- `https://.../api.php`

Tu dois recevoir un JSON du type:
- `{"error":"unknown_action","action":""}` ou un autre JSON valide

Puis recharge `index.html`.


## Correctif supplémentaire
- correction d'une erreur de syntaxe JavaScript dans `app.js` qui empêchait le chargement de `showTest()` et des autres fonctions.

- correction définitive de la ligne JS cassée autour du message Monaco.

## Correctif SQLite permissions

Cette version ne tente plus d'écrire aveuglément `devlab.db` dans le dossier web.

Ordre de résolution:
1. `JARVIS_DEVLAB_DB` si défini
2. `JARVIS_DEVLAB_DB_DIR` si défini
3. `config-web/data/devlab.db`
4. `/tmp/jarvis-devlab/devlab.db`

Le `healthcheck` renvoie maintenant aussi:
- `db_dir`
- `db_dir_writable`
