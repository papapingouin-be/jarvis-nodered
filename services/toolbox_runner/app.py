from __future__ import annotations

from time import perf_counter

from fastapi import FastAPI
from fastapi import Request

from services.common.logging_utils import configure_logging, log_event
from services.common.jarvis_types import ToolRunRequest
from services.toolbox_runner.registry import build_registry
from services.toolbox_runner.runner import ToolRunError, run_tool

app = FastAPI(title="toolbox_runner", version="1.0")
logger = configure_logging("toolbox_runner")
REGISTRY = build_registry()


@app.middleware("http")
async def log_http_requests(request: Request, call_next):
    started = perf_counter()
    log_event(
        logger,
        service="toolbox_runner",
        event="http_request",
        method=request.method,
        path=request.url.path,
        query=str(request.url.query or ""),
        client=(request.client.host if request.client else "unknown"),
    )
    response = await call_next(request)
    duration_ms = round((perf_counter() - started) * 1000, 2)
    log_event(
        logger,
        service="toolbox_runner",
        event="http_response",
        method=request.method,
        path=request.url.path,
        status_code=response.status_code,
        duration_ms=duration_ms,
    )
    return response


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
    log_event(
        logger,
        service="toolbox_runner",
        event="run_request",
        tool=payload.tool,
        input_keys=sorted(payload.input.keys()),
        context_keys=sorted(payload.context.keys()),
        input_intent=payload.input.get("intent"),
        input_operation=payload.input.get("operation"),
        req_id=payload.context.get("req_id"),
    )
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
