# Migration Portainer vers `jarvis_debug_studio`

## Source officielle Portainer

- **Fichier Portainer officiel :** `jarvis/portainer/stack.web-editor.yml`
- **Ne pas utiliser :** `compose.portainer.yml`
- **Règle de maintenance :** toute modification Portainer doit être faite uniquement dans `jarvis/portainer/stack.web-editor.yml`.
- **Interdiction :** ne jamais générer un nouveau fichier Compose/Portainer parallèle.

## Déploiement Portainer

Copier/coller (ou synchroniser) **uniquement** le contenu de `jarvis/portainer/stack.web-editor.yml` dans le Web Editor Portainer, puis déployer le stack.

## Vérification après déploiement

```bash
docker ps --format "table {{.Names}}\t{{.Ports}}\t{{.Status}}" | grep -E "debug|trace|toolbox"
```

Résultat attendu :

- `jarvis_debug_studio 0.0.0.0:4318->8060/tcp`
- `jarvis_toolbox_runner 0.0.0.0:8030->8030/tcp`

Il ne doit pas y avoir :

- `jarvis_trace_monitor 0.0.0.0:4318->4318/tcp`
