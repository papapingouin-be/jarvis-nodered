# Wiki Dev — Problèmes fréquents & solutions

> Objectif: garder une base de connaissance courte, actionnable et versionnée dans le repo.

## Est-ce qu’il existe une structure standard ?

Oui: dans les équipes, on utilise souvent une structure **Runbook + Troubleshooting + Décisions (ADR)**.

Dans ce dépôt, on peut rester simple avec ce fichier unique, et utiliser ce plan:

1. **Contexte** (où ça casse / impact)
2. **Symptômes** (logs, message exact)
3. **Cause probable**
4. **Solution validée**
5. **Prévention / checks**
6. **Références** (scripts, fichiers, commande)

---

## Index rapide

- [1) Portainer: “Control over this stack is limited”](#1-portainer-control-over-this-stack-is-limited)
- [2) Node-RED: `EACCES ... /data/settings.js`](#2-node-red-eacces-datasettingsjs)
- [3) Python: `file:///app does not appear to be a Python project`](#3-python-fileapp-does-not-appear-to-be-a-python-project)
- [4) Python: `Could not open requirements file`](#4-python-could-not-open-requirements-file)
- [5) Python: `ModuleNotFoundError: No module named 'services'`](#5-python-modulenotfounderror-no-module-named-services)
- [6) Observabilité: Loki/Grafana ne répond pas](#6-observabilité-lokigrafana-ne-répond-pas)

---

## 1) Portainer: “Control over this stack is limited”

### Symptômes
- Message affiché dans Portainer sur la stack.
- Contrôle partiel depuis l’UI.

### Cause probable
- Stack non créée/prise en charge directement par Portainer.

### Solution validée
- Redéployer la stack depuis l’UI Portainer (**Add stack**) avec le fichier compose dédié et les variables d’environnement.

### Prévention / checks
- Garder un process unique de déploiement (Portainer UI uniquement pour cette stack).

### Références
- `jarvis/portainer/stack.web-editor.yml`
- `jarvis/.env.portainer.example`

---

## 2) Node-RED: `EACCES ... /data/settings.js`

### Symptômes
- Erreur de copie/fichier au démarrage Node-RED.

### Cause probable
- Permissions insuffisantes sur le volume mappé pour `/data`.

### Solution validée
1. Définir `NODERED_USER=0:0` dans la stack Portainer (démarrage le plus robuste).
2. Si exécution non-root souhaitée, corriger ownership côté hôte (ex: UID/GID 1000).

### Prévention / checks
- Vérifier les droits du dossier `NODERED_DATA_PATH` avant déploiement.

### Références
- Variable `NODERED_USER`
- Variable `NODERED_DATA_PATH`

---

## 3) Python: `file:///app does not appear to be a Python project`

### Symptômes
- Build des services Python qui échoue avec ce message.

### Cause probable
- Tentative d’installer le projet racine avec `pip install -e .` dans un contexte non adapté.

### Solution validée
- Installer avec `pip install -r services/<service>/requirements.txt` pour chaque service.

### Prévention / checks
- Éviter `pip install -e .` dans les Dockerfiles/commands de service.

---

## 4) Python: `Could not open requirements file`

### Symptômes
- `No such file or directory: services/.../requirements.txt`.

### Cause probable
- `${JARVIS_HOST_ROOT}:/app` pointe vers un mauvais dossier (pas la racine du repo).

### Solution validée
- Corriger `JARVIS_HOST_ROOT` pour viser la racine du dépôt sur l’hôte Docker.

### Prévention / checks
- Vérifier depuis le conteneur que `/app/services/.../requirements.txt` existe.

---

## 5) Python: `ModuleNotFoundError: No module named 'services'`

### Symptômes
- Import `services.*` qui échoue au runtime.

### Cause probable
- Mauvais montage du repo dans `/app`.

### Solution validée
- Monter `${JARVIS_HOST_ROOT}:/app` et contrôler que `JARVIS_HOST_ROOT` pointe bien à la racine du dépôt.

### Prévention / checks
- Test rapide depuis conteneur:

```bash
python -c "import services; print('ok')"
```

---

## 6) Observabilité: Loki/Grafana ne répond pas

### Symptômes
- `curl` KO sur `3100` (Loki) ou `3011` (Grafana).

### Causes probables
- Réseaux Docker externes absents (`jarvis_net`, `jarvis_proxy`).
- Configs Loki/Promtail manquantes côté hôte.
- Ports non exposés / conflit de ports.

### Solution validée
1. Créer les réseaux externes.
2. Vérifier les fichiers de config montés.
3. Redémarrer la stack logs.

```bash
docker network create jarvis_net || true
docker network create jarvis_proxy || true
docker compose -f jarvis/portainer/stack.logs.yml up -d
curl -s http://localhost:3100/ready
curl -s http://localhost:3011/api/health
```

### Références
- `jarvis/portainer/stack.logs.yml`
- `jarvis/observability/loki-config.yml`
- `jarvis/observability/promtail-config.yml`

---

## Template pour ajouter un nouveau problème

Copier-coller ce bloc:

```md
## Titre court du problème

### Symptômes
- ...

### Cause probable
- ...

### Solution validée
1. ...

### Prévention / checks
- ...

### Références
- `path/fichier`
```

---

## Bonnes pratiques de maintenance de ce wiki

- Une entrée = un problème concret (pas de roman).
- Conserver le **message d’erreur exact**.
- Ajouter une **commande de vérification** après chaque solution.
- Mettre à jour le wiki dans la même PR que le correctif quand possible.
