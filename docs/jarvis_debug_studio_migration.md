# Migration vers outil unique `jarvis_debug_studio`

Objectif : unifier le debug/supervision sur **Jarvis Debug Studio**.

## 1) Arrêter l’ancien monitor

```bash
docker stop jarvis_trace_monitor
```

## 2) Redéployer le stack

```bash
docker compose -f compose.jarvis.yml up -d --force-recreate jarvis_debug_studio toolbox_runner
```

## 3) Vérifier les ports publiés

```bash
docker ps --format "table {{.Names}}\t{{.Ports}}\t{{.Status}}" | grep -E "debug|trace|toolbox"
```

Résultat attendu :

- `jarvis_debug_studio 0.0.0.0:4318->8060/tcp`
- `jarvis_toolbox_runner 0.0.0.0:8030->8030/tcp`

Il ne doit plus y avoir :

- `jarvis_trace_monitor 0.0.0.0:4318->4318/tcp`

## 4) Tests obligatoires

```bash
curl http://192.168.11.206:4318/health

curl http://192.168.11.206:4318/api/debug/status | jq

curl -X POST http://192.168.11.206:8030/debug/send-test-trace

curl http://192.168.11.206:4318/api/traces | jq

curl -X POST http://192.168.11.206:8030/debug/run-npm-with-trace

curl http://192.168.11.206:4318/api/traces | jq

curl http://192.168.11.206:8030/debug/real-calls | jq
```

## 5) Test OpenWebUI

Dans OpenWebUI, demander :

> Appelle l’outil debug_nonce et donne uniquement le nonce retourné.

Puis vérifier :

```bash
curl http://192.168.11.206:8030/debug/real-calls | jq
```

Si `debug_nonce` n’apparaît pas :

- Conclusion : OpenWebUI n’appelle pas réellement `toolbox_runner`, ou il est connecté à un autre serveur d’outils.

## 6) Rappels d’adressage

- Adresse navigateur (humaine) : `http://192.168.11.206:4318`
- Adresse interne Docker (services) : `http://jarvis_debug_studio:8060`
- `toolbox_runner` doit envoyer les traces vers : `http://jarvis_debug_studio:8060/api/trace/event`
