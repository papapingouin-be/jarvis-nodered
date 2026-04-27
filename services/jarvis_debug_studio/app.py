from __future__ import annotations

import json
import os
import re
import sqlite3
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from services.common.logging_utils import configure_logging, log_event

MAX_VALUE_LENGTH = int(os.getenv("JARVIS_DEBUG_STUDIO_MAX_VALUE_LENGTH", "4000"))
MAX_JSON_LENGTH = int(os.getenv("JARVIS_DEBUG_STUDIO_MAX_JSON_LENGTH", "30000"))
SECRET_KEY_RE = re.compile(r"(secret|password|token|api[-_]?key|authorization)", re.IGNORECASE)

logger = configure_logging("jarvis_debug_studio")
app = FastAPI(title="jarvis_debug_studio", version="1.0")


class TraceEventIn(BaseModel):
    trace_id: str = Field(min_length=1, max_length=128)
    tool: str = Field(min_length=1, max_length=128)
    stage: str = Field(min_length=1, max_length=128)
    payload: dict[str, Any] = Field(default_factory=dict)
    duration_ms: float | None = None
    has_error: bool = False


def _db_path() -> Path:
    configured = os.getenv("JARVIS_DEBUG_STUDIO_DB")
    if configured:
        return Path(configured)
    return Path("/opt/jarvis/database/jarvis_debug_studio.db")


def _connect() -> sqlite3.Connection:
    path = _db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS trace_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            trace_id TEXT NOT NULL,
            tool TEXT NOT NULL,
            stage TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            duration_ms REAL,
            has_error INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_trace_events_trace_id ON trace_events(trace_id)")
    conn.commit()
    return conn


def _truncate_string(value: str) -> str:
    if len(value) <= MAX_VALUE_LENGTH:
        return value
    return value[:MAX_VALUE_LENGTH] + "…[truncated]"


def _mask_and_limit(value: Any) -> Any:
    if isinstance(value, dict):
        sanitized: dict[str, Any] = {}
        for key, item in value.items():
            if SECRET_KEY_RE.search(key):
                sanitized[key] = "***"
                continue
            sanitized[key] = _mask_and_limit(item)
        return sanitized
    if isinstance(value, list):
        return [_mask_and_limit(item) for item in value[:100]]
    if isinstance(value, str):
        return _truncate_string(value)
    return value


def _serialize_payload(payload: dict[str, Any]) -> str:
    sanitized = _mask_and_limit(payload)
    encoded = json.dumps(sanitized, ensure_ascii=False)
    if len(encoded) <= MAX_JSON_LENGTH:
        return encoded
    return json.dumps(
        {
            "truncated": True,
            "preview": encoded[:MAX_JSON_LENGTH],
            "original_size": len(encoded),
        },
        ensure_ascii=False,
    )


@app.get("/health")
def health() -> dict[str, str]:
    log_event(logger, service="jarvis_debug_studio", event="healthcheck")
    return {"status": "ok"}


@app.post("/api/trace/event")
def post_trace_event(event: TraceEventIn) -> dict[str, Any]:
    conn = _connect()
    try:
        payload_json = _serialize_payload(event.payload)
        conn.execute(
            """
            INSERT INTO trace_events(trace_id, tool, stage, payload_json, duration_ms, has_error)
            VALUES(?, ?, ?, ?, ?, ?)
            """,
            (
                event.trace_id,
                event.tool,
                event.stage,
                payload_json,
                event.duration_ms,
                1 if event.has_error else 0,
            ),
        )
        conn.commit()
    finally:
        conn.close()

    return {"ok": True}


@app.get("/api/traces")
def get_traces(limit: int = 100) -> dict[str, list[dict[str, Any]]]:
    safe_limit = min(max(limit, 1), 500)
    conn = _connect()
    try:
        rows = conn.execute(
            """
            SELECT
              trace_id,
              MIN(tool) AS tool,
              COUNT(*) AS events,
              MAX(has_error) AS has_error,
              MIN(created_at) AS started_at,
              MAX(created_at) AS last_at,
              MAX(duration_ms) AS duration_ms
            FROM trace_events
            GROUP BY trace_id
            ORDER BY MAX(id) DESC
            LIMIT ?
            """,
            (safe_limit,),
        ).fetchall()
    finally:
        conn.close()

    return {"items": [dict(row) for row in rows]}


@app.get("/api/traces/{trace_id}")
def get_trace(trace_id: str) -> dict[str, Any]:
    conn = _connect()
    try:
        rows = conn.execute(
            """
            SELECT id, trace_id, tool, stage, payload_json, duration_ms, has_error, created_at
            FROM trace_events
            WHERE trace_id = ?
            ORDER BY id ASC
            """,
            (trace_id,),
        ).fetchall()
    finally:
        conn.close()

    if not rows:
        raise HTTPException(status_code=404, detail="trace not found")

    events = []
    for row in rows:
        event = dict(row)
        try:
            event["payload"] = json.loads(event.pop("payload_json"))
        except json.JSONDecodeError:
            event["payload"] = {"raw": event.pop("payload_json")}
        events.append(event)

    return {
        "trace_id": trace_id,
        "tool": events[0]["tool"],
        "events": events,
    }


@app.get("/")
def studio_index() -> FileResponse:
    return FileResponse(Path(__file__).parent / "static" / "index.html")


app.mount("/static", StaticFiles(directory=Path(__file__).parent / "static"), name="static")
