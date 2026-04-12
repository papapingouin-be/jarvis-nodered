# config-web

Interface web sobre (HTML/JS/PHP) pour gérer les valeurs de configuration des outils Jarvis.

## Schéma DB partagé (config-web + toolbox)

`config-web` et les tools Python utilisent **la même SQLite** (`JARVIS_INFRA_DB`, défaut `/tmp/jarvis_infra.db`).

Tables principales:

- `sensitive_values` (`namespace`, `key`, `value`, `updated_at`)
- `npm_instances` (`name`, `base_url`, `login`, `password`, `password_secret_key`)
- `npm_services` (`domain`, `instance_name`, `forward_host`, `forward_port`, `scheme`)
- `proxmox_targets` (`name`, `ip`, `api_path`, `login`, `password`, `password_secret_key`, `node`)
- `ct_services` (`name`, `target_name`, `ctid`, `path`)
- `devlab_runs` (créée par `devlab_backend` pour l'historique d'exécution)

Le backend `config-web/api.php` initialise maintenant ce schéma au démarrage pour que la DB soit explicite et stable.

## Outils/paramètres affichés

- `runtime`
  - `TOOLBOX_RUNNER_URL`
- `proxmox`
  - `PROXMOX_API_TOKEN_ID`
  - `PROXMOX_API_TOKEN_SECRET`
  - `PROXMOX_HOST`
  - `PROXMOX_PASSWORD`
  - `PROXMOX_SSH_PORT`
  - `PROXMOX_USER`
  - `PROXMOX_WEB`
- `npm_service`
  - `NPM_URL`
  - `NPM_IDENTITY`
  - `NPM_SECRET`

## Laboratoire outils Python (`.py`)

Un menu **Laboratoire outils .py** est disponible dans l'UI pour:

- lister **tous les fichiers `.py`** détectés sous `jarvis/toolbox/tools/**` (même sans manifest) ;
- distinguer les fichiers "exécutables" (manifest + entrypoint Python valide) des fichiers seulement éditables ;
- scanner le répertoire des outils et afficher un diagnostic détaillé (manifest/entrypoint) ;
- préremplir un JSON d'input proche de l'usage réel (selon le `input_schema`);
- exécuter l'outil via `toolbox_runner` (`POST /v1/run`) et afficher la réponse brute;
- exécuter un test global **Tester tous les outils** qui lance chaque outil détecté automatiquement ;
- charger/éditer/sauvegarder n'importe quel fichier `.py` détecté.
- accès direct `npm_service` avec:
  - bouton **Test rapide npm_service** (préremplit `{"operation":"list_services"}` puis exécute),
  - bouton **Ouvrir npm_service/tool.py** dans l'éditeur.

L'URL du runner est lue dans:

1. `runtime/TOOLBOX_RUNNER_URL` (table `sensitive_values`) si présent,
2. sinon fallback sur `http://localhost:8030`.

## Lancer localement

```bash
cd config-web
php -S 0.0.0.0:8080
```

Puis ouvrir `http://localhost:8080`.

## Dépannage flow-test / Node-RED

Si vous voyez une erreur du type `getaddrinfo EAI_AGAIN toolbox_runner`, Node-RED ne
résout pas le host `toolbox_runner`.

Sur `flow-test.html`, `meta.toolbox_runner_url` est injecté automatiquement :
- par défaut: `http://localhost:8030`
- au clic sur **Envoyer**: l'URL est dérivée de l'endpoint Node-RED (même host, port `8030`) si le champ n'est pas déjà défini dans `meta`.
- si la case **Utiliser runtime/TOOLBOX_RUNNER_URL depuis la DB** est cochée (par défaut), `flow-test` lit d'abord la valeur dans SQLite via `api.php` et l'injecte dans `meta.toolbox_runner_url`.

Vous pouvez donc configurer l'adresse du serveur toolbox runner depuis `index.html` :

- Outil: `runtime`
- Clé: `TOOLBOX_RUNNER_URL`
- Valeur exemple: `http://localhost:8030`

Vous pouvez forcer l'URL du toolbox runner depuis le payload entrant, par exemple:

```json
{
  "meta": {
    "source": "config-web-flow-test",
    "toolbox_runner_url": "http://localhost:8030"
  }
}
```

Le flow Jarvis donne maintenant priorité à `TOOLBOX_RUNNER_URL`, puis à
`meta.toolbox_runner_url`, puis fallback sur `http://localhost:8030` si rien n'est défini.

Pour forcer explicitement l'URL fournie dans le payload de test (et ignorer la variable
d'environnement), ajoutez `meta.force_toolbox_runner_url: true`.

Si votre payload de test n'utilise pas `text`, le normalize du flow accepte aussi
`input.source_text` et `message` pour éviter un `intent: unknown` avec texte vide.

## Base de données

Par défaut, `api.php` utilise:

1. `db_path` envoyé par le front (si renseigné), sinon
2. la variable d'environnement `JARVIS_INFRA_DB`, sinon
3. `/tmp/jarvis_infra.db`

Dans **DB Lab**, le bouton **Préremplir champs requis** ajoute automatiquement les clés minimales attendues par les tools (par ex. `runtime/TOOLBOX_RUNNER_URL`, `npm_service/NPM_URL`, `NPM_IDENTITY`, `NPM_SECRET`), afin de pouvoir enregistrer la configuration directement en DB avant exécution.
