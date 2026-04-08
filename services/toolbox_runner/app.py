from __future__ import annotations

from fastapi import FastAPI

from services.common.jarvis_types import ToolRunRequest
from services.toolbox_runner.registry import build_registry
from services.toolbox_runner.runner import ToolRunError, run_tool

app = FastAPI(title="toolbox_runner", version="1.0")
REGISTRY = build_registry()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/v1/run")
def run(payload: ToolRunRequest) -> dict:
    manifest = REGISTRY.get(payload.tool)
    if not manifest:
        return {
            "ok": False,
            "tool": payload.tool,
            "error_code": "MISSING_TOOL",
            "message": f"tool not found: {payload.tool}",
            "retryable": False,
            "data": {},
        }

    try:
        return run_tool(manifest, payload.input)
    except ToolRunError as exc:
        return {
            "ok": False,
            "tool": payload.tool,
            "error_code": exc.code,
            "message": exc.message,
            "retryable": exc.retryable,
            "data": {},
        }
