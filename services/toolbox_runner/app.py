from __future__ import annotations

import os
import uuid
from time import perf_counter

from fastapi import FastAPI
from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from services.common.logging_utils import configure_logging, log_event
from services.common.jarvis_types import ToolRunRequest
from services.toolbox_runner.registry import build_registry
from services.toolbox_runner.runner import ToolRunError, run_tool
from services.toolbox_runner.tracing import emit_trace_event

app = FastAPI(
    title="toolbox_runner",
    version="1.0",
    docs_url="/docs",
)
app.openapi_version = "3.0.3"
logger = configure_logging("toolbox_runner")
REGISTRY = build_registry()


def _cors_allowed_origins() -> list[str]:
    origins_env = os.getenv("TOOLBOX_CORS_ALLOW_ORIGINS", "*")
    origins = [origin.strip() for origin in origins_env.split(",") if origin.strip()]
    return origins or ["*"]


def _http_log_excluded_paths() -> set[str]:
    raw = os.getenv("TOOLBOX_LOG_EXCLUDE_PATHS", "/openapi.json,/docs,/docs/oauth2-redirect")
    return {part.strip() for part in raw.split(",") if part.strip()}


app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_allowed_origins(),
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def log_http_requests(request: Request, call_next):
    if request.url.path in _http_log_excluded_paths():
        return await call_next(request)

    started = perf_counter()
    client_ip = request.client.host if request.client else "unknown"
    request_id = request.headers.get("x-request-id") or str(uuid.uuid4())
    log_event(
        logger,
        service="toolbox_runner",
        event="http_request",
        request_id=request_id,
        method=request.method,
        path=request.url.path,
        query=str(request.url.query or ""),
        client=client_ip,
        origin=request.headers.get("origin"),
        referer=request.headers.get("referer"),
        user_agent=request.headers.get("user-agent"),
    )
    try:
        response = await call_next(request)
    except Exception as exc:
        duration_ms = round((perf_counter() - started) * 1000, 2)
        log_event(
            logger,
            service="toolbox_runner",
            event="http_error",
            request_id=request_id,
            method=request.method,
            path=request.url.path,
            client=client_ip,
            duration_ms=duration_ms,
            error_type=type(exc).__name__,
            error=str(exc),
        )
        raise
    else:
        duration_ms = round((perf_counter() - started) * 1000, 2)
        log_event(
            logger,
            service="toolbox_runner",
            event="http_response",
            request_id=request_id,
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


def _available_tool_names() -> list[str]:
    if not REGISTRY:
        _refresh_registry()
    return sorted(REGISTRY.keys())


def _execute_tool(tool: str, tool_input: dict, context: dict | None = None, trace_id: str = "") -> dict:
    context = context or {}
    if not trace_id:
        trace_id = str(context.get("trace_id") or "")
    log_event(
        logger,
        service="toolbox_runner",
        event="run_request",
        tool=tool,
        input_keys=sorted(tool_input.keys()),
        context_keys=sorted(context.keys()),
        input_intent=tool_input.get("intent"),
        input_operation=tool_input.get("operation"),
        req_id=context.get("req_id"),
        trace_id=trace_id,
    )
    manifest = REGISTRY.get(tool)
    if not manifest:
        manifest = _refresh_registry().get(tool)
    if not manifest:
        return {
            "ok": False,
            "tool": tool,
            "error_code": "MISSING_TOOL",
            "message": f"tool not found: {tool}",
            "retryable": False,
            "data": {"available_tools": sorted(REGISTRY.keys())},
        }

    trace_hook = None
    if trace_id and tool == "npm_service":
        trace_hook = lambda stage, payload, duration_ms=None, has_error=False: emit_trace_event(
            trace_id=trace_id,
            tool=tool,
            stage=stage,
            payload=payload,
            duration_ms=duration_ms,
            has_error=has_error,
        )

    try:
        return run_tool(manifest, tool_input, trace_hook=trace_hook)
    except ToolRunError as exc:
        if trace_hook is not None:
            trace_hook("error", {"code": exc.code, "message": exc.message}, has_error=True)
        log_event(logger, service="toolbox_runner", event="run_error", tool=tool, code=exc.code, trace_id=trace_id)
        return {
            "ok": False,
            "tool": tool,
            "error_code": exc.code,
            "message": exc.message,
            "retryable": exc.retryable,
            "data": {},
        }


@app.exception_handler(RequestValidationError)
async def request_validation_exception_handler(request: Request, exc: RequestValidationError):
    if request.url.path not in {"/v1/run", "/run"}:
        return JSONResponse(status_code=422, content={"detail": exc.errors()})

    missing_tool = any(
        err.get("type") == "missing" and err.get("loc", [None])[-1] == "tool"
        for err in exc.errors()
    )
    if not missing_tool:
        return JSONResponse(status_code=422, content={"detail": exc.errors()})

    tools = _available_tool_names()
    log_event(
        logger,
        service="toolbox_runner",
        event="run_validation_error",
        path=request.url.path,
        reason="missing_tool",
        available_tools=tools,
    )
    return JSONResponse(
        status_code=422,
        content={
            "ok": False,
            "error_code": "MISSING_REQUIRED_FIELD",
            "message": "missing required field: tool",
            "data": {
                "required": ["tool"],
                "available_tools": tools,
                "example": {"tool": tools[0] if tools else "example_echo", "input": {}, "context": {}},
            },
        },
    )


@app.get(
    "/health",
    tags=["jarvis_tools"],
    summary="Health check",
    description="Return service status to verify that toolbox_runner is alive.",
    operation_id="jarvis_health_check",
)
def health() -> dict[str, str]:
    log_event(logger, service="toolbox_runner", event="healthcheck")
    return {"status": "ok"}


@app.get(
    "/v1/tools",
    tags=["jarvis_tools"],
    summary="List available tools",
    description="Return the list of available tools registered in the toolbox registry.",
    operation_id="jarvis_list_tools",
)
def list_tools() -> dict[str, list[str]]:
    tools = _available_tool_names()
    log_event(
        logger,
        service="toolbox_runner",
        event="list_tools",
        count=len(tools),
        tools=tools,
    )
    return {"tools": tools}


@app.post(
    "/v1/run",
    tags=["jarvis_tools"],
    summary="Execute tool",
    description="Execute a tool from the toolbox registry using the provided input payload.",
    operation_id="jarvis_execute_tool",
)
def run(payload: ToolRunRequest, request: Request) -> dict:
    header_trace_id = request.headers.get("x-trace-id") or ""
    return _execute_tool(payload.tool, payload.input, payload.context, header_trace_id)


@app.post(
    "/v1/run/{tool}",
    tags=["jarvis_tools"],
    summary="Execute tool by path",
    description="Execute a tool from the toolbox registry using the path parameter and a direct input payload.",
    operation_id="jarvis_execute_tool_by_path",
)
def run_by_path(tool: str, payload: dict, request: Request) -> dict:
    header_trace_id = request.headers.get("x-trace-id") or ""
    return _execute_tool(tool, payload, {}, header_trace_id)


@app.post(
    "/run",
    tags=["jarvis_tools"],
    summary="Execute tool (compat)",
    description="Compatibility alias for /v1/run.",
    operation_id="jarvis_execute_tool_compat",
)
def run_compat(payload: ToolRunRequest, request: Request) -> dict:
    header_trace_id = request.headers.get("x-trace-id") or ""
    return _execute_tool(payload.tool, payload.input, payload.context, header_trace_id)


@app.post(
    "/run/{tool}",
    tags=["jarvis_tools"],
    summary="Execute tool by path (compat)",
    description="Compatibility alias for /v1/run/{tool}.",
    operation_id="jarvis_execute_tool_by_path_compat",
)
def run_by_path_compat(tool: str, payload: dict, request: Request) -> dict:
    header_trace_id = request.headers.get("x-trace-id") or ""
    return _execute_tool(tool, payload, {}, header_trace_id)
