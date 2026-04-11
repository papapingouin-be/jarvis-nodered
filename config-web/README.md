# config-web

Interface web sobre (HTML/JS/PHP) pour gérer les valeurs de configuration des outils Jarvis.

## Ce qui est stocké

- `sensitive_values` uniquement (`namespace`, `key`, `value`).
- Les `CT services` et `NPM services` **ne sont pas stockés en DB**: ces informations sont transmises au moment d'exécuter l'outil.

## Outils/paramètres affichés

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

## Lancer localement

```bash
cd config-web
php -S 0.0.0.0:8080
```

Puis ouvrir `http://localhost:8080`.

## Dépannage flow-test / Node-RED

Si vous voyez une erreur du type `getaddrinfo EAI_AGAIN toolbox_runner`, Node-RED ne
résout pas le host `toolbox_runner`.

Sur `flow-test.html`, `meta.toolbox_runner_url` n'est plus injecté automatiquement :
ajoutez-le manuellement dans le payload si nécessaire.

Vous pouvez forcer l'URL du toolbox runner depuis le payload entrant, par exemple:

```json
{
  "meta": {
    "source": "config-web-flow-test",
    "toolbox_runner_url": "http://localhost:8030"
  }
}
```

Le flow Jarvis donne priorité à `meta.toolbox_runner_url` (payload de test), puis à
`TOOLBOX_RUNNER_URL`, puis fallback sur `http://localhost:8030` si rien n'est défini.

Si votre payload de test n'utilise pas `text`, le normalize du flow accepte aussi
`input.source_text` et `message` pour éviter un `intent: unknown` avec texte vide.

## Base de données

Par défaut, `api.php` utilise:

1. `db_path` envoyé par le front (si renseigné), sinon
2. la variable d'environnement `JARVIS_INFRA_DB`, sinon
3. `/tmp/jarvis_infra.db`
