# config-web

Mini interface web (HTML/JS/PHP) pour gérer les entrées SQLite nécessaires aux outils MCP Jarvis:

- `sensitive_values`
- `proxmox_targets`
- `ct_services`
- `npm_instances`
- `npm_services`

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

Le backend crée automatiquement les tables si elles n'existent pas.

## Test du flux Node-RED (flux de base)

Une page dédiée est disponible pour envoyer un `JarvisMessage` vers Node-RED:

- `http://localhost:8080/flow-test.html`

Renseigne l'endpoint (par défaut `http://localhost:1880/jarvis/inbound`), adapte le JSON puis clique sur **Tester le flux**.
