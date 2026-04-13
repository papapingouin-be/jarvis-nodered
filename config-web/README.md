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
