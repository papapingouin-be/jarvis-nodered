# Architecture V1

Node-RED orchestre les flux et appelle 5 micro-services FastAPI:
- llm_adapter
- openproject_adapter
- toolbox_runner
- git_bridge
- log_bridge

Le registre des outils est construit depuis `jarvis/toolbox/tools/*/manifest.json`.
