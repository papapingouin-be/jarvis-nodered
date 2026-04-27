from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from time import perf_counter
from typing import Any, Callable

from services.common.logging_utils import configure_logging, log_event
from services.common.jsonschema_utils import validate_against_schema, validate_payload

logger = configure_logging("toolbox_runner.runner")
TraceHook = Callable[[str, dict[str, Any], float | None, bool], None]


class ToolRunError(RuntimeError):
    def __init__(self, code: str, message: str, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable


def _validate(schema: dict[str, Any], payload: dict[str, Any]) -> None:
    try:
        validate_against_schema(schema, payload)
    except Exception as exc:
        raise ToolRunError("VALIDATION_ERROR", str(exc)) from exc


def _emit(trace_hook: TraceHook | None, stage: str, payload: dict[str, Any], duration_ms: float | None = None, has_error: bool = False) -> None:
    if trace_hook is None:
        return
    trace_hook(stage, payload, duration_ms, has_error)


def run_tool(manifest: dict[str, Any], tool_input: dict[str, Any], trace_hook: TraceHook | None = None) -> dict[str, Any]:
    started = perf_counter()
    tool_name = manifest["name"]
    _emit(trace_hook, "entry", {"input": tool_input})

    _validate(manifest["input_schema"], tool_input)
    _emit(trace_hook, "validation", {"status": "ok"})

    entrypoint = Path(manifest["tool_root"]) / manifest["entrypoint"]
    script_detected = entrypoint.suffix == ".py"
    timeout_s = int(os.getenv("TOOL_TIMEOUT_S", "30"))
    command = ["python", str(entrypoint)]

    _emit(
        trace_hook,
        "handler",
        {
            "handler": tool_name,
            "entrypoint": str(entrypoint),
            "timeout_s": timeout_s,
        },
    )
    _emit(trace_hook, "code_preview", {"code_preview": " ".join(command)})

    log_event(
        logger,
        service="toolbox_runner",
        event="tool_execute_start",
        tool=tool_name,
        entrypoint=str(entrypoint),
        timeout_s=timeout_s,
        script_exists=entrypoint.exists(),
        script_suffix=entrypoint.suffix,
        python_script_detected=script_detected,
        command=command,
        input_keys=sorted(tool_input.keys()),
    )
    try:
        result = subprocess.run(
            command,
            input=json.dumps(tool_input),
            text=True,
            capture_output=True,
            timeout=timeout_s,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        log_event(logger, service="toolbox_runner", event="tool_execute_timeout", tool=tool_name, timeout_s=timeout_s)
        _emit(trace_hook, "timeout", {"error": f"tool timeout after {timeout_s}s"}, (perf_counter() - started) * 1000, True)
        raise ToolRunError("TIMEOUT", f"tool timeout after {timeout_s}s", retryable=True) from exc

    stdout_text = (result.stdout or "").strip()
    stderr_text = (result.stderr or "").strip()
    _emit(trace_hook, "stdout", {"stdout": stdout_text})
    _emit(trace_hook, "stderr", {"stderr": stderr_text}, has_error=bool(stderr_text))

    if result.returncode != 0:
        stderr = stderr_text or stdout_text or "tool crashed"
        log_event(logger, service="toolbox_runner", event="tool_execute_crash", tool=tool_name, return_code=result.returncode, stderr=stderr[:500])
        _emit(
            trace_hook,
            "raw_output",
            {"return_code": result.returncode, "raw_output": stdout_text or stderr_text},
            (perf_counter() - started) * 1000,
            True,
        )
        raise ToolRunError("TOOL_CRASH", stderr)

    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        log_event(logger, service="toolbox_runner", event="tool_execute_invalid_json", tool=tool_name)
        _emit(trace_hook, "raw_output", {"raw_output": stdout_text}, (perf_counter() - started) * 1000, True)
        raise ToolRunError("INVALID_JSON", "tool returned non-json output") from exc

    _emit(trace_hook, "raw_output", {"raw_output": data})
    _validate(manifest["output_schema"], data)
    tool_logs = [{"level": "info", "message": f"{tool_name} executed"}]

    if stderr_text:
        for line in stderr_text.splitlines():
            tool_logs.append({"level": "info", "message": line[:500]})
        log_event(
            logger,
            service="toolbox_runner",
            event="tool_execute_stderr",
            tool=tool_name,
            lines=len(stderr_text.splitlines()),
        )

    output = {
        "ok": True,
        "tool": tool_name,
        "action": "run_tool",
        "message": "done",
        "data": data,
        "artifacts": [],
        "warnings": [],
        "logs": tool_logs,
    }
    validate_payload("tool_output.schema.json", output)
    duration_ms = round((perf_counter() - started) * 1000, 2)
    _emit(trace_hook, "exit", {"output": output}, duration_ms)
    log_event(logger, service="toolbox_runner", event="tool_execute_done", tool=tool_name)
    return output
