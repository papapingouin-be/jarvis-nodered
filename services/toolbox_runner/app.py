from __future__ import annotations

import os
import uuid
import json
from pathlib import Path
from time import perf_counter
from datetime import datetime, timezone

from fastapi import FastAPI
from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from services.common.logging_utils import configure_logging, log_event
from services.common.jarvis_types import ToolRunRequest
from services.toolbox_runner.registry import build_registry
from services.toolbox_runner.runner import ToolRunError, run_tool
from services.toolbox_runner.trace_client import (
    TraceClient,
    gateway_url,
    new_run_id,
    new_trace_id,
    trace_code_preview_enabled,
    trace_enabled,
    trace_payloads_enabled,
)

app = FastAPI(
    title="toolbox_runner",
    version="1.0",
    docs_url="/docs",
)
app.openapi_version = "3.0.3"
logger = configure_logging("toolbox_runner")
REGISTRY = build_registry()
REAL_CALLS_LOG_PATH = Path(os.getenv("TOOLBOX_REAL_CALLS_LOG", "/tmp/toolbox_real_calls.log"))


class OpenWebUiToolRequest(BaseModel):
    input: dict = Field(default_factory=dict)
    context: dict = Field(default_factory=dict)


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


def _execute_tool_with_trace(tool: str, tool_input: dict, context: dict | None = None) -> tuple[dict, TraceClient]:
    context = context or {}
    trace_id = context.get("trace_id") or context.get("req_id") or new_trace_id()
    run_id = context.get("run_id") or new_run_id(tool)
    trace = TraceClient(trace_id, run_id, tool)
    print(f"TRACE_WRAPPER_ENTERED tool={tool} trace_id={trace_id}")
    trace.event(
        "request.received",
        "running",
        input=tool_input,
        metadata={
            "context_keys": sorted(context.keys()),
            "input_keys": sorted(tool_input.keys()),
            "req_id": context.get("req_id"),
        },
    )
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
        run_id=run_id,
    )
    manifest = REGISTRY.get(tool)
    if not manifest:
        trace.event("registry.refresh", "running", metadata={"reason": "tool_not_found_in_memory"})
        manifest = _refresh_registry().get(tool)
    if not manifest:
        result = {
            "ok": False,
            "tool": tool,
            "error_code": "MISSING_TOOL",
            "message": f"tool not found: {tool}",
            "retryable": False,
            "data": {"available_tools": sorted(REGISTRY.keys())},
        }
        trace.event("tool.selected", "error", input=tool_input, output=result, error_code="MISSING_TOOL", error_message=result["message"])
        return result, trace

    trace.event("tool.selected", "ok", input=tool_input, metadata={"manifest": {k: v for k, v in manifest.items() if k != "input_schema" and k != "output_schema"}})
    try:
        return run_tool(manifest, tool_input, trace=trace), trace
    except ToolRunError as exc:
        trace.event("response.returned", "error", input=tool_input, error_code=exc.code, error_message=exc.message, metadata={"retryable": exc.retryable})
        log_event(logger, service="toolbox_runner", event="run_error", tool=tool, code=exc.code, trace_id=trace_id, run_id=run_id)
        return {
            "ok": False,
            "tool": tool,
            "error_code": exc.code,
            "message": exc.message,
            "retryable": exc.retryable,
            "data": {"trace_id": trace_id, "run_id": run_id},
        }, trace


def _execute_tool(tool: str, tool_input: dict, context: dict | None = None) -> dict:
    result, _ = _execute_tool_with_trace(tool, tool_input, context)
    return result


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _append_real_call(*, tool: str, tool_input: dict, context: dict | None = None) -> dict:
    context = context or {}
    trace_id = context.get("trace_id") or context.get("req_id") or "generated"
    payload = {
        "timestamp": _now_iso(),
        "marker": "REAL_TOOLBOX_RUN_CALLED",
        "tool": tool,
        "input": tool_input,
        "trace_id": trace_id,
        "trace_enabled": trace_enabled(),
        "trace_gateway_url": gateway_url(),
    }
    print(f"### REAL_TOOLBOX_RUN_CALLED ### {json.dumps(payload, ensure_ascii=False, default=str)}")
    REAL_CALLS_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with REAL_CALLS_LOG_PATH.open("a", encoding="utf-8") as fp:
        fp.write(json.dumps(payload, ensure_ascii=False, default=str) + "\n")
    return payload


def _read_last_real_calls(limit: int = 50) -> list[dict]:
    if not REAL_CALLS_LOG_PATH.exists():
        return []
    lines = REAL_CALLS_LOG_PATH.read_text(encoding="utf-8").splitlines()
    out: list[dict] = []
    for line in lines[-limit:]:
        if not line.strip():
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            out.append({"timestamp": _now_iso(), "marker": "REAL_TOOLBOX_RUN_CALLED", "parse_error": line[:300]})
    return out


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




@app.get("/debug/trace-config")
def debug_trace_config() -> dict:
    trace_gateway = gateway_url()
    return {
        "service": "toolbox_runner",
        "trace_enabled": trace_enabled(),
        "trace_gateway_url": trace_gateway,
        "trace_payloads": trace_payloads_enabled(),
        "trace_code_preview": trace_code_preview_enabled(),
        "pid": os.getpid(),
        "cwd": str(Path.cwd()),
        "env_present": {
            "TRACE_ENABLED": "TRACE_ENABLED" in os.environ,
            "TRACE_GATEWAY_URL": "TRACE_GATEWAY_URL" in os.environ,
        },
    }


@app.post("/debug/send-test-trace")
def debug_send_test_trace() -> dict:
    trace = TraceClient("manual-toolbox-test", "manual-toolbox-test", "debug")
    result = trace.send_custom_event(
        {
            "trace_id": "manual-toolbox-test",
            "run_id": "manual-toolbox-test",
            "source": "toolbox_runner",
            "service": "toolbox_runner",
            "tool": "debug",
            "phase": "manual.test",
            "status": "ok",
            "input": {"message": "test from toolbox_runner"},
            "output": {},
            "metadata": {},
        }
    )
    return result


@app.post("/debug/run-npm-with-trace")
def debug_run_npm_with_trace() -> dict:
    payload = {
        "tool": "npm_service",
        "input": {"intent": "list.services"},
        "context": {"trace_id": "debug-npm-direct"},
    }
    result, trace = _execute_tool_with_trace(payload["tool"], payload["input"], payload["context"])
    return {
        "result": result,
        "trace_id": trace.trace_id,
        "trace_send_status": trace.last_send_result,
    }


@app.get("/debug/real-calls")
def debug_real_calls() -> dict:
    calls = _read_last_real_calls(50)
    return {"count": len(calls), "items": calls, "log_path": str(REAL_CALLS_LOG_PATH)}


@app.post("/debug/run-nonce")
def debug_run_nonce() -> dict:
    payload = ToolRunRequest(tool="debug_nonce", input={}, context={"trace_id": f"debug-nonce-{uuid.uuid4().hex[:10]}"})
    result = run(payload)
    return {"result": result, "trace_id": payload.context["trace_id"]}


@app.post(
    "/v1/run",
    tags=["jarvis_tools"],
    summary="Execute tool",
    description="Execute a tool from the toolbox registry using the provided input payload.",
    operation_id="jarvis_execute_tool",
)
def run(payload: ToolRunRequest) -> dict:
    _append_real_call(tool=payload.tool, tool_input=payload.input, context=payload.context)
    return _execute_tool(payload.tool, payload.input, payload.context)


@app.post(
    "/v1/run/{tool}",
    tags=["jarvis_tools"],
    summary="Execute tool by path",
    description="Execute a tool from the toolbox registry using the path parameter and a direct input payload.",
    operation_id="jarvis_execute_tool_by_path",
)
def run_by_path(tool: str, payload: dict) -> dict:
    _append_real_call(tool=tool, tool_input=payload, context={})
    return _execute_tool(tool, payload, {})


@app.post(
    "/run",
    tags=["jarvis_tools"],
    summary="Execute tool (compat)",
    description="Compatibility alias for /v1/run.",
    operation_id="jarvis_execute_tool_compat",
)
def run_compat(payload: ToolRunRequest) -> dict:
    _append_real_call(tool=payload.tool, tool_input=payload.input, context=payload.context)
    return _execute_tool(payload.tool, payload.input, payload.context)


@app.post(
    "/run/{tool}",
    tags=["jarvis_tools"],
    summary="Execute tool by path (compat)",
    description="Compatibility alias for /v1/run/{tool}.",
    operation_id="jarvis_execute_tool_by_path_compat",
)
def run_by_path_compat(tool: str, payload: dict) -> dict:
    _append_real_call(tool=tool, tool_input=payload, context={})
    return _execute_tool(tool, payload, {})


@app.post(
    "/openwebui/debug_nonce",
    tags=["openwebui_tools"],
    summary="Generate runtime nonce",
    description="Generate a real runtime nonce from toolbox_runner.",
    operation_id="debug_nonce",
)
def openwebui_debug_nonce(payload: OpenWebUiToolRequest) -> dict:
    _append_real_call(tool="debug_nonce", tool_input=payload.input, context=payload.context)
    result = _execute_tool("debug_nonce", payload.input, payload.context)
    data = result.get("data", {}) if isinstance(result, dict) else {}
    return {
        "nonce": data.get("nonce"),
        "source": data.get("source", "real_toolbox_runner"),
    }


@app.post(
    "/openwebui/npm_service_list",
    tags=["openwebui_tools"],
    summary="List npm services",
    description="List npm services using npm_service.",
    operation_id="npm_service_list",
)
def openwebui_npm_service_list(payload: OpenWebUiToolRequest) -> dict:
    merged_input = {"intent": "list.services", **payload.input}
    _append_real_call(tool="npm_service", tool_input=merged_input, context=payload.context)
    result = _execute_tool("npm_service", merged_input, payload.context)
    data = result.get("data", {}) if isinstance(result, dict) else {}
    services = data.get("services")
    if services is None and isinstance(data.get("items"), list):
        services = data.get("items")
    return {"services": services if isinstance(services, list) else []}
