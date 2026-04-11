from __future__ import annotations

import json
import os

from fastapi import FastAPI

from services.common.logging_utils import configure_logging, log_event
from services.common.jsonschema_utils import validate_payload
from services.openproject_adapter.client import build_project_payload, build_work_package_payload

app = FastAPI(title="openproject_adapter", version="1.0")
logger = configure_logging("openproject_adapter")


@app.get("/health")
def health() -> dict[str, str]:
    log_event(logger, service="openproject_adapter", event="healthcheck")
    return {"status": "ok"}


@app.post("/v1/jarvis/create_project_from_spec")
def create_project_from_spec(payload: dict) -> dict:
    jarvis_project = payload["jarvis_project"]
    log_event(logger, service="openproject_adapter", event="create_project_from_spec", project_title=jarvis_project.get("title"))
    validate_payload("jarvis_project.schema.json", jarvis_project)
    project_payload = build_project_payload(jarvis_project["title"], jarvis_project["summary"])
    custom_field_map = payload.get("custom_field_map") or json.loads(
        os.getenv("OP_CUSTOM_FIELD_MAP_JSON", "{}")
    )
    work_packages = [
        build_work_package_payload(
            project_id=1,
            subject=task["title"],
            description_md=jarvis_project["objective"],
            custom_field_map=custom_field_map,
            jarvis_fields={
                "jarvis_action_type": task.get("type", "analysis"),
                "jarvis_executor": "jarvis",
                "jarvis_status": "ready",
                "jarvis_tool_needed": task.get("tool_needed", ""),
            },
        )
        for task in jarvis_project["tasks"]
    ]
    return {"project": project_payload, "work_packages": work_packages, "note": "V1 payload only"}


@app.get("/v1/jarvis/list_ready_tasks")
def list_ready_tasks() -> dict:
    log_event(logger, service="openproject_adapter", event="list_ready_tasks")
    return {
        "tasks": [
            {
                "project_id": "demo",
                "task_id": "T1",
                "subject": "Echo",
                "jarvis_action_type": "run_tool",
                "jarvis_tool_needed": "example_echo",
                "input": {"message": "hello from poller"},
            }
        ]
    }


@app.post("/v1/jarvis/update_task")
def update_task(payload: dict) -> dict:
    log_event(logger, service="openproject_adapter", event="update_task", payload_keys=sorted(payload.keys()))
    return {"ok": True, "payload": payload}
