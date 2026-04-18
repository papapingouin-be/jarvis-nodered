# http_probe

Outil d'inventaire + vérification HTTP.

## Cas d'usage

- Enregistrer des endpoints de santé (`name -> url`).
- Vérifier rapidement qu'un endpoint répond avec le statut attendu.
- Donner au LLM une source de vérité structurée (pas de réponse "au feeling").

## Intents

- `registry.register_endpoint`
- `list.endpoints`
- `check.endpoint`
- `check.all`
- `inspect.describe`

## Exemples

### 1) Décrire l'outil

```json
{
  "intent": "inspect.describe"
}
```

### 2) Enregistrer un endpoint

```json
{
  "intent": "registry.register_endpoint",
  "name": "nodered-local",
  "url": "http://localhost:1880",
  "expected_status": 200,
  "timeout_s": 5
}
```

### 3) Lister les endpoints

```json
{
  "intent": "list.endpoints"
}
```

### 4) Vérifier un endpoint

```json
{
  "intent": "check.endpoint",
  "name": "nodered-local"
}
```

### 5) Vérifier tous les endpoints

```json
{
  "intent": "check.all"
}
```

## Notes

- `expected_status` et `timeout_s` sont utiles au `register`.
- `check.endpoint` récupère URL/statut attendu depuis la DB; il faut donc avoir fait un `register` avant.
- `check.all` fait la même chose pour tous les endpoints enregistrés et renvoie un résumé `ok_count/failed_count`.
- DB utilisée: `JARVIS_INFRA_DB` si défini, sinon fallback `jarvis.db`.
