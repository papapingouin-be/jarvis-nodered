from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any

from services.common.logging_utils import configure_logging, log_event
from services.common.jsonschema_utils import validate_against_schema, validate_payload

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


def run_tool(manifest: dict[str, Any], tool_input: dict[str, Any]) -> dict[str, Any]:
    _validate(manifest["input_schema"], tool_input)
    entrypoint = Path(manifest["tool_root"]) / manifest["entrypoint"]
    script_detected = entrypoint.suffix == ".py"
    timeout_s = int(os.getenv("TOOL_TIMEOUT_S", "30"))
    command = ["python", str(entrypoint)]
    log_event(
        logger,
        service="toolbox_runner",
        event="tool_execute_start",
        tool=manifest["name"],
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
        log_event(logger, service="toolbox_runner", event="tool_execute_timeout", tool=manifest["name"], timeout_s=timeout_s)
        raise ToolRunError("TIMEOUT", f"tool timeout after {timeout_s}s", retryable=True) from exc

    if result.returncode != 0:
        stderr = result.stderr.strip() or result.stdout.strip() or "tool crashed"
        log_event(logger, service="toolbox_runner", event="tool_execute_crash", tool=manifest["name"], return_code=result.returncode, stderr=stderr[:500])
        raise ToolRunError("TOOL_CRASH", stderr)

    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        log_event(logger, service="toolbox_runner", event="tool_execute_invalid_json", tool=manifest["name"])
        raise ToolRunError("INVALID_JSON", "tool returned non-json output") from exc

    _validate(manifest["output_schema"], data)
    tool_logs = [{"level": "info", "message": f"{manifest['name']} executed"}]
    stderr_text = (result.stderr or "").strip()
    if stderr_text:
        for line in stderr_text.splitlines():
            tool_logs.append({"level": "info", "message": line[:500]})
        log_event(
            logger,
            service="toolbox_runner",
            event="tool_execute_stderr",
            tool=manifest["name"],
            lines=len(stderr_text.splitlines()),
        )

    output = {
        "ok": True,
        "tool": manifest["name"],
        "action": "run_tool",
        "message": "done",
        "data": data,
        "artifacts": [],
        "warnings": [],
        "logs": tool_logs,
    }
    validate_payload("tool_output.schema.json", output)
    log_event(logger, service="toolbox_runner", event="tool_execute_done", tool=manifest["name"])
    return output
