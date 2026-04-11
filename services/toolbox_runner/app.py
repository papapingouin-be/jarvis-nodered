from __future__ import annotations

from fastapi import FastAPI

from services.common.logging_utils import configure_logging, log_event
from services.common.jarvis_types import ToolRunRequest
from services.toolbox_runner.registry import build_registry
from services.toolbox_runner.runner import ToolRunError, run_tool

app = FastAPI(title="toolbox_runner", version="1.0")
logger = configure_logging("toolbox_runner")
REGISTRY = build_registry()


def _refresh_registry() -> dict:
    global REGISTRY
    REGISTRY = build_registry()
    return REGISTRY


@app.get("/health")
def health() -> dict[str, str]:
    log_event(logger, service="toolbox_runner", event="healthcheck")
    return {"status": "ok"}


@app.post("/v1/run")
def run(payload: ToolRunRequest) -> dict:
    log_event(logger, service="toolbox_runner", event="run_request", tool=payload.tool)
    manifest = REGISTRY.get(payload.tool)
    if not manifest:
        manifest = _refresh_registry().get(payload.tool)
    if not manifest:
        return {
            "ok": False,
            "tool": payload.tool,
            "error_code": "MISSING_TOOL",
            "message": f"tool not found: {payload.tool}",
            "retryable": False,
            "data": {"available_tools": sorted(REGISTRY.keys())},
        }

    try:
        return run_tool(manifest, payload.input)
    except ToolRunError as exc:
        log_event(logger, service="toolbox_runner", event="run_error", tool=payload.tool, code=exc.code)
        return {
            "ok": False,
            "tool": payload.tool,
            "error_code": exc.code,
            "message": exc.message,
            "retryable": exc.retryable,
            "data": {},
        }
