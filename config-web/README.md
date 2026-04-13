# Jarvis DevLab V6

Contenu:
- `index.html`
- `app.js`
- `api.php`

## Ce que fait cette V6

- vue **Configurer** centrée sur les besoins du service
- vue **Tester** avec moteur, payload JSON, sortie et logs
- vue **Code** avec Monaco, lecture/sauvegarde/validation
- vue **Historique** des exécutions
- **DB Lab** remis dans l'outil:
  - lister les tables
  - prévisualiser une table SQLite
  - lister la configuration stockée
  - ajouter / modifier / supprimer une config

## Tables SQLite

- `infra_meta`
- `service_config_values`
- `devlab_runs`

## Résolution DB

Ordre:
1. `JARVIS_DEVLAB_DB`
2. `JARVIS_DEVLAB_DB_DIR`
3. `config-web/data/devlab.db`
4. `/tmp/jarvis-devlab/devlab.db`

## Limites honnêtes

- le moteur réel disponible ici est `python_direct`
- il envoie le JSON sur **stdin** au `tool.py`
- si tes tools ne lisent pas stdin, utilise `plan_only` ou adapte le runner ensuite
- `toolbox_runner` n'est pas encore branché dans cette version

## Déploiement

Copie les fichiers dans ton dossier web `config-web`.

Teste ensuite:
- `index.html`
- le bouton **DB Lab**
- l'action `healthcheck` au chargement

## Vérification rapide

Dans la console navigateur:

```js
fetch("api.php", {
  method: "POST",
  headers: {"Content-Type":"application/json"},
  body: JSON.stringify({action:"healthcheck"})
}).then(r => r.json()).then(console.log)
```
