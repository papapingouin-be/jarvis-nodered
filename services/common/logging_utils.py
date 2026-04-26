from __future__ import annotations

import json
import logging
import os
from contextlib import suppress
from datetime import datetime, timezone
from typing import Any
from urllib import request


def configure_logging(name: str) -> logging.Logger:
    logger = logging.getLogger(name)
    if logger.handlers:
        return logger
    handler = logging.StreamHandler()
    formatter = logging.Formatter("%(message)s")
    handler.setFormatter(formatter)
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    return logger


def to_json_log(payload: dict) -> str:
    return json.dumps(payload, ensure_ascii=False)


def _build_trace_event(service: str, event: str, fields: dict[str, Any]) -> dict[str, Any]:
    now_iso = datetime.now(timezone.utc).isoformat()
    ts = fields.get("ts") or fields.get("timestamp") or now_iso
    trace_id = (
        fields.get("trace_id")
        or fields.get("traceId")
        or fields.get("conversation_id")
        or fields.get("conversationId")
        or fields.get("request_id")
        or fields.get("correlation_id")
        or f"{service}:{event}"
    )
    summary = fields.get("summary") or fields.get("message") or event.replace("_", " ")
    level = fields.get("level")
    status = fields.get("status")
    if status is None and isinstance(level, str):
        lowered = level.lower()
        if lowered in {"error", "critical"}:
            status = "error"
        elif lowered in {"warning", "warn"}:
            status = "warning"

    details = {k: v for k, v in fields.items() if k not in {"ts", "timestamp", "trace_id", "traceId", "summary"}}
    return {
        "ts": ts,
        "service": service,
        "trace_id": str(trace_id),
        "event": event,
        "summary": str(summary),
        "level": level if isinstance(level, str) else "info",
        "status": status if isinstance(status, str) else None,
        "details": details,
    }


def _push_to_trace_monitor(payload: dict[str, Any]) -> None:
    base_url = os.getenv("TRACE_MONITOR_URL", "").strip().rstrip("/")
    if not base_url:
        return
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = request.Request(
        f"{base_url}/api/events",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with suppress(Exception):
        request.urlopen(req, timeout=1.2).read()


def log_event(logger: logging.Logger, service: str, event: str, **fields: Any) -> None:
    payload = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "service": service,
        "event": event,
        **fields,
    }
    logger.info(to_json_log(payload))
    _push_to_trace_monitor(_build_trace_event(service=service, event=event, fields=fields))
