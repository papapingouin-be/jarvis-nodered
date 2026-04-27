from __future__ import annotations

import json
import os
import re
from typing import Any
from urllib import error, request

SECRET_KEY_RE = re.compile(r"(secret|password|token|api[-_]?key|authorization)", re.IGNORECASE)
MAX_STRING = int(os.getenv("TOOLBOX_TRACE_MAX_STRING", "3000"))
MAX_JSON = int(os.getenv("TOOLBOX_TRACE_MAX_JSON", "20000"))


def sanitize_for_trace(value: Any) -> Any:
    if isinstance(value, dict):
        output: dict[str, Any] = {}
        for key, item in value.items():
            if SECRET_KEY_RE.search(key):
                output[key] = "***"
                continue
            output[key] = sanitize_for_trace(item)
        return output
    if isinstance(value, list):
        return [sanitize_for_trace(item) for item in value[:100]]
    if isinstance(value, str):
        return value if len(value) <= MAX_STRING else value[:MAX_STRING] + "…[truncated]"
    return value


def emit_trace_event(
    *,
    trace_id: str,
    tool: str,
    stage: str,
    payload: dict[str, Any],
    duration_ms: float | None = None,
    has_error: bool = False,
) -> None:
    base_url = os.getenv("JARVIS_DEBUG_STUDIO_URL", "").strip()
    if not base_url or not trace_id:
        return

    sanitized_payload = sanitize_for_trace(payload)
    payload_json = json.dumps(sanitized_payload, ensure_ascii=False)
    if len(payload_json) > MAX_JSON:
        sanitized_payload = {
            "truncated": True,
            "preview": payload_json[:MAX_JSON],
            "original_size": len(payload_json),
        }

    body = json.dumps(
        {
            "trace_id": trace_id,
            "tool": tool,
            "stage": stage,
            "payload": sanitized_payload,
            "duration_ms": duration_ms,
            "has_error": has_error,
        },
        ensure_ascii=False,
    ).encode("utf-8")

    req = request.Request(
        f"{base_url.rstrip('/')}/api/trace/event",
        method="POST",
        headers={"Content-Type": "application/json"},
        data=body,
    )
    try:
        with request.urlopen(req, timeout=2):
            pass
    except error.URLError:
        return
