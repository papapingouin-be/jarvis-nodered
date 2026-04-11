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
  - liste vide

## Lancer localement

```bash
cd config-web
php -S 0.0.0.0:8080
```

Puis ouvrir `http://localhost:8080`.

## Base de données

Par défaut, `api.php` utilise:

1. `db_path` envoyé par le front (si renseigné), sinon
2. la variable d'environnement `JARVIS_INFRA_DB`, sinon
3. `/tmp/jarvis_infra.db`
