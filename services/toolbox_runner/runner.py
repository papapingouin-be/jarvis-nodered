from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any

from services.common.logging_utils import configure_logging, log_event
from services.common.jsonschema_utils import validate_against_schema, validate_payload
from services.toolbox_runner.trace_client import TraceClient, StepTimer

logger = configure_logging("toolbox_runner.runner")


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


def _read_code_preview(entrypoint: Path) -> str:
    if os.getenv("TRACE_CODE_PREVIEW", "true").strip().lower() not in {"1", "true", "yes", "on"}:
        return ""
    if not entrypoint.exists() or not entrypoint.is_file():
        return ""
    max_bytes = int(os.getenv("TRACE_MAX_CODE_BYTES", "40000"))
    max_lines = int(os.getenv("TRACE_MAX_CODE_LINES", "160"))
    text = entrypoint.read_text(encoding="utf-8", errors="replace")[:max_bytes]
    lines = text.splitlines()
    if len(lines) > max_lines:
        text = "\n".join(lines[:max_lines]) + f"\n# ...[truncated {len(lines) - max_lines} lines]"
    return text


def _base_metadata(manifest: dict[str, Any], entrypoint: Path, command: list[str], timeout_s: int) -> dict[str, Any]:
    return {
        "tool_root": manifest.get("tool_root"),
        "entrypoint": str(entrypoint),
        "entrypoint_exists": entrypoint.exists(),
        "entrypoint_suffix": entrypoint.suffix,
        "command": command,
        "timeout_s": timeout_s,
        "manifest_description": manifest.get("description"),
        "input_schema_required": manifest.get("input_schema", {}).get("required", []),
    }


def _emit_legacy_trace(
    trace_hook: Any | None,
    stage: str,
    payload: dict[str, Any],
    *,
    duration_ms: float | None = None,
    has_error: bool = False,
) -> None:
    if trace_hook is None:
        return
    trace_hook(stage, payload, duration_ms, has_error)


def run_tool(
    manifest: dict[str, Any],
    tool_input: dict[str, Any],
    trace: TraceClient | None = None,
    trace_hook: Any | None = None,
) -> dict[str, Any]:
    tool_name = manifest["name"]
    trace = trace or TraceClient(None, None, tool_name)
    total_timer = StepTimer()
    _emit_legacy_trace(trace_hook, "entry", {"tool": tool_name, "input": tool_input})

    validation_timer = StepTimer()
    trace.event("validation.start", "running", input=tool_input, metadata={"schema": manifest.get("input_schema", {})})
    try:
        _validate(manifest["input_schema"], tool_input)
    except ToolRunError as exc:
        _emit_legacy_trace(
            trace_hook,
            "validation",
            {"error_code": exc.code, "error_message": exc.message, "input": tool_input},
            duration_ms=validation_timer.ms(),
            has_error=True,
        )
        trace.event("validation.error", "error", input=tool_input, duration_ms=validation_timer.ms(), error_code=exc.code, error_message=exc.message)
        raise
    trace.event("validation.ok", "ok", input=tool_input, duration_ms=validation_timer.ms())
    _emit_legacy_trace(trace_hook, "validation", {"input": tool_input}, duration_ms=validation_timer.ms())

    entrypoint = Path(manifest["tool_root"]) / manifest["entrypoint"]
    script_detected = entrypoint.suffix == ".py"
    timeout_s = int(os.getenv("TOOL_TIMEOUT_S", "30"))
    command = ["python", str(entrypoint)]
    metadata = _base_metadata(manifest, entrypoint, command, timeout_s)
    metadata["python_script_detected"] = script_detected
    metadata["code_preview"] = _read_code_preview(entrypoint)

    trace.event("handler.resolved", "ok", input=tool_input, metadata=metadata)
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

    exec_timer = StepTimer()
    trace.event("code.execution.start", "running", input=tool_input, metadata=metadata)
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
        trace.event("code.execution.error", "error", input=tool_input, metadata=metadata, duration_ms=exec_timer.ms(), error_code="TIMEOUT", error_message=f"tool timeout after {timeout_s}s")
        log_event(logger, service="toolbox_runner", event="tool_execute_timeout", tool=tool_name, timeout_s=timeout_s)
        raise ToolRunError("TIMEOUT", f"tool timeout after {timeout_s}s", retryable=True) from exc

    raw = {
        "returncode": result.returncode,
        "stdout": result.stdout,
        "stderr": result.stderr,
    }
    if result.stdout:
        trace.event("code.execution.stdout", "ok", output={"stdout": result.stdout}, metadata={"bytes": len(result.stdout)})
        _emit_legacy_trace(trace_hook, "stdout", {"stdout": result.stdout})
    if result.stderr:
        trace.event("code.execution.stderr", "warning", output={"stderr": result.stderr}, metadata={"bytes": len(result.stderr)})

    if result.returncode != 0:
        stderr = result.stderr.strip() or result.stdout.strip() or "tool crashed"
        _emit_legacy_trace(
            trace_hook,
            "exit",
            {"returncode": result.returncode, "stderr": stderr},
            duration_ms=exec_timer.ms(),
            has_error=True,
        )
        trace.event("code.execution.error", "error", output=raw, metadata=metadata, duration_ms=exec_timer.ms(), error_code="TOOL_CRASH", error_message=stderr[:2000])
        log_event(logger, service="toolbox_runner", event="tool_execute_crash", tool=tool_name, return_code=result.returncode, stderr=stderr[:500])
        raise ToolRunError("TOOL_CRASH", stderr)

    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        trace.event("code.execution.error", "error", output=raw, metadata=metadata, duration_ms=exec_timer.ms(), error_code="INVALID_JSON", error_message="tool returned non-json output")
        log_event(logger, service="toolbox_runner", event="tool_execute_invalid_json", tool=tool_name)
        raise ToolRunError("INVALID_JSON", "tool returned non-json output") from exc

    trace.event("code.execution.result", "ok", input=tool_input, output={"raw_output": data}, metadata=metadata, duration_ms=exec_timer.ms())

    output_validation_timer = StepTimer()
    try:
        _validate(manifest["output_schema"], data)
    except ToolRunError as exc:
        trace.event("output.validation.error", "error", output=data, duration_ms=output_validation_timer.ms(), error_code="OUTPUT_VALIDATION_ERROR", error_message=exc.message)
        raise ToolRunError("OUTPUT_VALIDATION_ERROR", exc.message) from exc
    trace.event("output.validation.ok", "ok", output=data, duration_ms=output_validation_timer.ms())

    tool_logs = [{"level": "info", "message": f"{tool_name} executed"}]
    stderr_text = (result.stderr or "").strip()
    if stderr_text:
        for line in stderr_text.splitlines():
            tool_logs.append({"level": "info", "message": line[:500]})
        log_event(logger, service="toolbox_runner", event="tool_execute_stderr", tool=tool_name, lines=len(stderr_text.splitlines()))

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
    _emit_legacy_trace(trace_hook, "exit", {"returncode": result.returncode, "output": output}, duration_ms=total_timer.ms())
    trace.event("response.returned", "ok", input=tool_input, output=output, duration_ms=total_timer.ms())
    log_event(logger, service="toolbox_runner", event="tool_execute_done", tool=tool_name)
    return output
