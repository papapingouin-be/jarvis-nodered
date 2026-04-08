from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any

from services.common.jsonschema_utils import validate_against_schema, validate_payload


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
    timeout_s = int(os.getenv("TOOL_TIMEOUT_S", "30"))
    try:
        result = subprocess.run(
            ["python", str(entrypoint)],
            input=json.dumps(tool_input),
            text=True,
            capture_output=True,
            timeout=timeout_s,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise ToolRunError("TIMEOUT", f"tool timeout after {timeout_s}s", retryable=True) from exc

    if result.returncode != 0:
        stderr = result.stderr.strip() or result.stdout.strip() or "tool crashed"
        raise ToolRunError("TOOL_CRASH", stderr)

    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise ToolRunError("INVALID_JSON", "tool returned non-json output") from exc

    _validate(manifest["output_schema"], data)
    output = {
        "ok": True,
        "tool": manifest["name"],
        "action": "run_tool",
        "message": "done",
        "data": data,
        "artifacts": [],
        "warnings": [],
        "logs": [{"level": "info", "message": f"{manifest['name']} executed"}],
    }
    validate_payload("tool_output.schema.json", output)
    return output
