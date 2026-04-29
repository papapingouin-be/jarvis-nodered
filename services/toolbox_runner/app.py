from __future__ import annotations

import os
import uuid
import json
import random
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
LIST_TOOLS_DECISIONS_LIMIT = 50


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


def _execute_tool_with_trace(tool: str, tool_input: dict, context: dict | None = None, request: Request | None = None) -> tuple[dict, TraceClient]:
    context = context or {}
    trace_id = context.get("trace_id") or context.get("req_id") or new_trace_id()
    run_id = context.get("run_id") or new_run_id(tool)
    trace = TraceClient(trace_id, run_id, tool)
    print(f"TRACE_WRAPPER_ENTERED tool={tool} trace_id={trace_id}")
    request_info = build_request_info(request) if request else {}
    caller_type, caller_label = detect_caller(request_info) if request else ("unknown", "Unknown caller")
    caller_metadata = {"caller_type": caller_type, "caller_label": caller_label, "request_info": request_info}
    trace.event(
        "request.received",
        "received",
        input=tool_input,
        metadata={
            "context_keys": sorted(context.keys()),
            "input_keys": sorted(tool_input.keys()),
            "req_id": context.get("req_id"),
            **caller_metadata,
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
        trace.event("tool.selected", "error", input=tool_input, output=result, error_code="MISSING_TOOL", error_message=result["message"], metadata=caller_metadata)
        return result, trace

    trace.event("tool.selected", "ok", input=tool_input, metadata={"manifest": {k: v for k, v in manifest.items() if k != "input_schema" and k != "output_schema"}, **caller_metadata})
    try:
        result = run_tool(manifest, tool_input, trace=trace, caller_info=caller_metadata)
        trace.event("response.returned", "ok", output=result, metadata=caller_metadata)
        return result, trace
    except ToolRunError as exc:
        trace.event("response.returned", "error", input=tool_input, error_code=exc.code, error_message=exc.message, metadata={"retryable": exc.retryable, **caller_metadata})
        log_event(logger, service="toolbox_runner", event="run_error", tool=tool, code=exc.code, trace_id=trace_id, run_id=run_id)
        return {
            "ok": False,
            "tool": tool,
            "error_code": exc.code,
            "message": exc.message,
            "retryable": exc.retryable,
            "data": {"trace_id": trace_id, "run_id": run_id},
        }, trace


def _execute_tool(tool: str, tool_input: dict, context: dict | None = None, request: Request | None = None) -> dict:
    result, _ = _execute_tool_with_trace(tool, tool_input, context, request)
    return result


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _append_real_call(*, marker: str, tool: str, tool_input: dict, trace_id: str) -> dict:
    payload = {
        "timestamp": _now_iso(),
        "marker": marker,
        "tool": tool,
        "input": tool_input,
        "trace_id": trace_id,
        "trace_enabled": trace_enabled(),
        "trace_gateway_url": gateway_url(),
    }
    print(f"### {marker} ### {json.dumps(payload, ensure_ascii=False, default=str)}")
    REAL_CALLS_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with REAL_CALLS_LOG_PATH.open("a", encoding="utf-8") as fp:
        fp.write(json.dumps(payload, ensure_ascii=False, default=str) + "\n")
    return payload


def _trace_id_from_context(context: dict | None = None) -> str:
    context = context or {}
    return str(context.get("trace_id") or context.get("req_id") or "generated")


def _new_tools_list_trace_id() -> str:
    return f"tools-list-{int(datetime.now(timezone.utc).timestamp() * 1000)}-{random.randint(1000, 9999)}"


def should_suppress_trace_reason(request: Request) -> str | None:
    suppress_headers = {
        "x-jarvis-debug-probe": "header:x-jarvis-debug-probe",
        "x-jarvis-trace-suppress": "header:x-jarvis-trace-suppress",
    }
    for header, reason in suppress_headers.items():
        if request.headers.get(header, "").strip().lower() == "true":
            return reason

    user_agent = request.headers.get("user-agent", "").lower()
    source = request.headers.get("x-source", "").lower()
    if "jarvis_debug_studio" in user_agent or "jarvis-debug-studio" in user_agent:
        return "user-agent:jarvis_debug_studio"
    if "jarvis_debug_studio" in source or "jarvis-debug-studio" in source:
        return "header:x-source:jarvis_debug_studio"

    if request.query_params.get("suppress_trace", "").lower() == "true":
        return "query:suppress_trace"

    return None


def should_suppress_trace(request: Request) -> bool:
    return should_suppress_trace_reason(request) is not None


def _is_docker_ip(host: str | None) -> bool:
    if not host:
        return False
    return host.startswith("172.") or host.startswith("10.") or host.startswith("192.168.")


def detect_caller(request_info: dict) -> tuple[str, str]:
    headers = request_info.get("headers_redacted", {})
    ua = str(request_info.get("user_agent") or "").lower()
    path = str(request_info.get("path") or "").lower()
    if str(headers.get("x-jarvis-debug-probe", "")).lower() == "true":
        return "jarvis_debug_studio", "Jarvis Debug Studio probe"
    if "curl" in ua:
        return "curl", "curl client"
    referer_origin = f"{request_info.get('origin','')} {request_info.get('referer','')}".lower()
    if "openwebui" in referer_origin or "18080" in referer_origin:
        return "openwebui", "OpenWebUI / jarvis_openwebui"
    if "openwebui" in ua or headers.get("x-openwebui-user-id") or path.startswith("/openwebui"):
        return "openwebui", "OpenWebUI / jarvis_openwebui"
    if path.startswith("/debug"):
        return "manual_debug", "Manual debug endpoint"
    if "mozilla" in ua:
        return "browser", "Browser"
    if _is_docker_ip(str(request_info.get("client_host") or "")):
        return "internal_docker", "Internal Docker service"
    return "unknown", "Unknown caller"


def build_request_info(request: Request) -> dict:
    raw_headers = dict(request.headers)
    redacted = {}
    for k, v in raw_headers.items():
        key = k.lower()
        if any(token in key for token in ["authorization", "cookie", "set-cookie", "x-api-key", "api-key", "token", "secret", "password"]):
            redacted[k] = "***REDACTED***"
        else:
            redacted[k] = v
    return {
        "client_host": request.client.host if request.client else None,
        "client_port": request.client.port if request.client else None,
        "method": request.method,
        "path": request.url.path,
        "query": str(request.url.query or ""),
        "user_agent": request.headers.get("user-agent"),
        "referer": request.headers.get("referer"),
        "origin": request.headers.get("origin"),
        "x_forwarded_for": request.headers.get("x-forwarded-for"),
        "x_openwebui_user_id": request.headers.get("x-openwebui-user-id"),
        "x_openwebui_chat_id": request.headers.get("x-openwebui-chat-id"),
        "x_request_id": request.headers.get("x-request-id"),
        "headers_redacted": redacted,
    }


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


def _read_list_tools_decisions(limit: int = LIST_TOOLS_DECISIONS_LIMIT) -> list[dict]:
    calls = _read_last_real_calls(limit=500)
    decisions = [item for item in calls if item.get("marker") == "LIST_TOOLS_TRACE_DECISION"]
    return decisions[-limit:]


def _list_tools_trace_decision(request: Request, caller_type: str) -> tuple[bool, str]:
    debug_probe = request.headers.get("x-jarvis-debug-probe", "").strip().lower() == "true"
    suppress = request.headers.get("x-jarvis-trace-suppress", "").strip().lower() == "true"
    force = request.headers.get("x-jarvis-trace-force", "").strip().lower() == "true"
    if debug_probe:
        return False, "debug_probe"
    if suppress:
        return False, "suppressed_header"
    if force:
        return True, "forced"
    if caller_type == "openwebui":
        return True, "openwebui"
    return False, "default_no_trace"


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
def list_tools(request: Request) -> dict[str, list[str]]:
    tools = _available_tool_names()
    request_info = build_request_info(request)
    caller_type, caller_label = detect_caller(request_info)
    trace_list_tools = os.getenv("TRACE_LIST_TOOLS", "").strip().lower()
    force_trace = request.headers.get("x-jarvis-trace-force", "").strip().lower() == "true"
    debug_probe = request.headers.get("x-jarvis-debug-probe", "").strip().lower() == "true"
    suppress = request.headers.get("x-jarvis-trace-suppress", "").strip().lower() == "true"
    print(
        "### LIST_TOOLS_ENDPOINT_CALLED ### "
        f"client_host={request_info.get('client_host')} "
        f"method={request_info.get('method')} "
        f"path={request_info.get('path')} "
        f"user_agent={request_info.get('user_agent')} "
        f"headers_redacted={json.dumps(request_info.get('headers_redacted', {}), ensure_ascii=False, default=str)} "
        f"TRACE_LIST_TOOLS={trace_list_tools} "
        f"X-Jarvis-Trace-Force={force_trace} "
        f"X-Jarvis-Debug-Probe={debug_probe} "
        f"X-Jarvis-Trace-Suppress={suppress}"
    )
    should_trace, reason = _list_tools_trace_decision(request, caller_type)
    print(
        "LIST_TOOLS_TRACE_DECISION "
        f"caller_type={caller_type} force={force_trace} suppress={suppress} debug_probe={debug_probe} trace={should_trace} reason={reason}"
    )
    _append_real_call(
        marker="LIST_TOOLS_TRACE_DECISION",
        tool="jarvis_list_tools",
        tool_input={
            "caller_type": caller_type,
            "trace": should_trace,
            "reason": reason,
            "client_host": request_info.get("client_host"),
            "user_agent": request_info.get("user_agent"),
            "path": "/v1/tools",
            "force": force_trace,
            "suppress": suppress,
            "debug_probe": debug_probe,
            "trace_list_tools": trace_list_tools,
        },
        trace_id=request.headers.get("x-trace-id") or request.query_params.get("trace_id") or _new_tools_list_trace_id(),
    )
    if not should_trace:
        print(f"TRACE_SUPPRESSED reason={reason} path=/v1/tools")
        log_event(logger, service="toolbox_runner", event="list_tools_suppressed", count=len(tools), tools=tools, reason=reason)
        return {"tools": tools}

    request_trace_id = request.headers.get("x-trace-id") or request.query_params.get("trace_id")
    trace_id = request_trace_id or _new_tools_list_trace_id()
    trace = TraceClient(trace_id, new_run_id("jarvis_list_tools"), "jarvis_list_tools")

    print("### REAL_TOOLBOX_LIST_TOOLS_CALLED ###")
    _append_real_call(
        marker="REAL_TOOLBOX_LIST_TOOLS_CALLED",
        tool="jarvis_list_tools",
        tool_input={},
        trace_id=trace.trace_id,
    )

    trace.event(
        "request.received",
        "ok",
        input={},
        metadata={"path": "/v1/tools", "query": str(request.url.query or ""), "request_info": request_info, "caller_type": caller_type, "caller_label": caller_label, "trace_decision_reason": reason},
    )
    trace.event("tool.selected", "ok", input={}, metadata={"tool": "jarvis_list_tools", "service": "toolbox_runner", "caller_type": caller_type, "caller_label": caller_label, "request_info": request_info, "trace_decision_reason": reason})
    output = {"tools": tools}
    trace.event("code.execution.result", "ok", output=output, metadata={"caller_type": caller_type, "caller_label": caller_label, "request_info": request_info, "trace_decision_reason": reason})
    trace.event("response.returned", "ok", output=output, metadata={"caller_type": caller_type, "caller_label": caller_label, "request_info": request_info, "trace_decision_reason": reason})

    log_event(
        logger,
        service="toolbox_runner",
        event="list_tools",
        count=len(tools),
        tools=tools,
        trace_id=trace.trace_id,
    )
    return output




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


@app.get("/debug/list-tools-decisions")
def debug_list_tools_decisions() -> dict:
    decisions = _read_list_tools_decisions(50)
    return {"count": len(decisions), "items": decisions, "log_path": str(REAL_CALLS_LOG_PATH)}


@app.post("/debug/run-nonce")
def debug_run_nonce(request: Request) -> dict:
    payload = ToolRunRequest(tool="debug_nonce", input={}, context={"trace_id": f"debug-nonce-{uuid.uuid4().hex[:10]}"})
    result = _execute_tool(payload.tool, payload.input, payload.context, request)
    return {"result": result, "trace_id": payload.context["trace_id"]}


@app.post(
    "/v1/run",
    tags=["jarvis_tools"],
    summary="Execute tool",
    description="Execute a tool from the toolbox registry using the provided input payload.",
    operation_id="jarvis_execute_tool",
)
def run(payload: ToolRunRequest, request: Request) -> dict:
    _append_real_call(marker="REAL_TOOLBOX_RUN_CALLED", tool=payload.tool, tool_input=payload.input, trace_id=_trace_id_from_context(payload.context))
    return _execute_tool(payload.tool, payload.input, payload.context, request)


@app.post(
    "/v1/run/{tool}",
    tags=["jarvis_tools"],
    summary="Execute tool by path",
    description="Execute a tool from the toolbox registry using the path parameter and a direct input payload.",
    operation_id="jarvis_execute_tool_by_path",
)
def run_by_path(tool: str, payload: dict, request: Request) -> dict:
    _append_real_call(marker="REAL_TOOLBOX_RUN_CALLED", tool=tool, tool_input=payload, trace_id="generated")
    return _execute_tool(tool, payload, {}, request)


@app.post(
    "/run",
    tags=["jarvis_tools"],
    summary="Execute tool (compat)",
    description="Compatibility alias for /v1/run.",
    operation_id="jarvis_execute_tool_compat",
)
def run_compat(payload: ToolRunRequest, request: Request) -> dict:
    _append_real_call(marker="REAL_TOOLBOX_RUN_CALLED", tool=payload.tool, tool_input=payload.input, trace_id=_trace_id_from_context(payload.context))
    return _execute_tool(payload.tool, payload.input, payload.context, request)


@app.post(
    "/run/{tool}",
    tags=["jarvis_tools"],
    summary="Execute tool by path (compat)",
    description="Compatibility alias for /v1/run/{tool}.",
    operation_id="jarvis_execute_tool_by_path_compat",
)
def run_by_path_compat(tool: str, payload: dict, request: Request) -> dict:
    _append_real_call(marker="REAL_TOOLBOX_RUN_CALLED", tool=tool, tool_input=payload, trace_id="generated")
    return _execute_tool(tool, payload, {}, request)


@app.post(
    "/openwebui/debug_nonce",
    tags=["openwebui_tools"],
    summary="Generate runtime nonce",
    description="Generate a real runtime nonce from toolbox_runner.",
    operation_id="debug_nonce",
)
def openwebui_debug_nonce(payload: OpenWebUiToolRequest, request: Request) -> dict:
    _append_real_call(marker="REAL_TOOLBOX_RUN_CALLED", tool="debug_nonce", tool_input=payload.input, trace_id=_trace_id_from_context(payload.context))
    result = _execute_tool("debug_nonce", payload.input, payload.context, request)
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
def openwebui_npm_service_list(payload: OpenWebUiToolRequest, request: Request) -> dict:
    merged_input = {"intent": "list.services", **payload.input}
    _append_real_call(marker="REAL_TOOLBOX_RUN_CALLED", tool="npm_service", tool_input=merged_input, trace_id=_trace_id_from_context(payload.context))
    result = _execute_tool("npm_service", merged_input, payload.context, request)
    data = result.get("data", {}) if isinstance(result, dict) else {}
    services = data.get("services")
    if services is None and isinstance(data.get("items"), list):
        services = data.get("items")
    return {"services": services if isinstance(services, list) else []}
