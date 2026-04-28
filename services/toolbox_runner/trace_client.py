from __future__ import annotations

import json
import os
import socket
import time
import uuid
from datetime import datetime, timezone
from typing import Any
from urllib import error, request

SECRET_KEYS = ("password", "secret", "token", "api_key", "apikey", "authorization", "credential")


def trace_enabled() -> bool:
    return os.getenv("TRACE_ENABLED", "false").strip().lower() in {"1", "true", "yes", "on"}


def trace_payloads_enabled() -> bool:
    return os.getenv("TRACE_PAYLOADS", "false").strip().lower() in {"1", "true", "yes", "on"}


def trace_code_preview_enabled() -> bool:
    return os.getenv("TRACE_CODE_PREVIEW", "false").strip().lower() in {"1", "true", "yes", "on"}


def gateway_url() -> str:
    return os.getenv("TRACE_GATEWAY_URL") or os.getenv("TRACE_MONITOR_URL") or "http://jarvis_debug_studio:8060"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_trace_id() -> str:
    return f"trace-{uuid.uuid4()}"


def new_run_id(tool: str) -> str:
    return f"{tool}-{uuid.uuid4().hex[:12]}"


def redact(value: Any) -> Any:
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for k, v in value.items():
            if any(key in str(k).lower() for key in SECRET_KEYS):
                out[k] = "***REDACTED***"
            else:
                out[k] = redact(v)
        return out
    if isinstance(value, list):
        return [redact(v) for v in value[:300]]
    if isinstance(value, str):
        max_len = int(os.getenv("TRACE_MAX_STRING", "8000"))
        if len(value) > max_len:
            return value[:max_len] + "\n...[truncated]"
    return value


class TraceClient:
    def __init__(self, trace_id: str | None, run_id: str | None, tool: str | None):
        self.trace_id = trace_id or new_trace_id()
        self.run_id = run_id or new_run_id(tool or "tool")
        self.tool = tool
        self.source = os.getenv("SERVICE_NAME", "toolbox_runner")
        self.service = os.getenv("SERVICE_NAME", "toolbox_runner")
        self.enabled = trace_enabled()
        self.url = gateway_url().rstrip("/") + "/api/trace/event"
        self.last_send_result: dict[str, Any] = {
            "sent": False,
            "target_url": self.url,
            "http_status": None,
            "response_body": "",
            "error": "not_sent",
        }

    def _send_payload(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not self.enabled:
            result = {
                "sent": False,
                "target_url": self.url,
                "http_status": None,
                "response_body": "",
                "error": "TRACE_ENABLED=false",
            }
            self.last_send_result = result
            return result

        data = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
        req = request.Request(self.url, data=data, headers={"Content-Type": "application/json"}, method="POST")
        print(f"TRACE_SEND_ATTEMPT target={self.url}")
        try:
            with request.urlopen(req, timeout=float(os.getenv("TRACE_POST_TIMEOUT_S", "0.8"))) as resp:
                body = resp.read(2048).decode("utf-8", errors="replace")
                result = {
                    "sent": True,
                    "target_url": self.url,
                    "http_status": resp.status,
                    "response_body": body,
                    "error": "",
                }
                print(f"TRACE_SEND_OK status={resp.status}")
        except (error.URLError, socket.timeout, TimeoutError, OSError) as exc:
            result = {
                "sent": False,
                "target_url": self.url,
                "http_status": None,
                "response_body": "",
                "error": f"{type(exc).__name__}: {exc}",
            }
            print(f"TRACE_SEND_ERROR error={result['error']}")
        self.last_send_result = result
        return result

    def send_custom_event(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._send_payload(payload)

    def event(self, phase: str, status: str = "ok", *, input: Any | None = None, output: Any | None = None,
              metadata: dict[str, Any] | None = None, duration_ms: float | None = None,
              error_code: str | None = None, error_message: str | None = None) -> None:
        payload = {
            "trace_id": self.trace_id,
            "run_id": self.run_id,
            "timestamp": now_iso(),
            "source": self.source,
            "service": self.service,
            "tool": self.tool,
            "phase": phase,
            "status": status,
            "duration_ms": duration_ms,
            "input": redact(input or {}),
            "output": redact(output or {}),
            "metadata": redact(metadata or {}),
            "error_code": error_code,
            "error_message": error_message,
        }
        self._send_payload(payload)


class StepTimer:
    def __init__(self) -> None:
        self.start = time.perf_counter()

    def ms(self) -> float:
        return round((time.perf_counter() - self.start) * 1000, 2)
