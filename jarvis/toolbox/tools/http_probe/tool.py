#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import sqlite3
import sys
import time
from pathlib import Path
from typing import Any
from urllib import error, request
from urllib.parse import urlparse

INTENT_ALIASES = {
    "registry.register_endpoint": "register_endpoint",
    "register_endpoint": "register_endpoint",
    "list.endpoints": "list_endpoints",
    "list_endpoints": "list_endpoints",
    "check.endpoint": "check_endpoint",
    "check_endpoint": "check_endpoint",
    "inspect.describe": "describe",
    "describe": "describe",
}


def _db_path() -> Path:
    env_db = os.getenv("JARVIS_INFRA_DB")
    if env_db:
        return Path(env_db)

    opt_db = Path("/opt/jarvis/database/jarvis.db")
    if opt_db.exists() or opt_db.parent.exists():
        return opt_db

    return Path(__file__).resolve().parents[3] / "database" / "jarvis.db"


def _connect() -> sqlite3.Connection:
    path = _db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS http_probe_endpoints (
            name TEXT PRIMARY KEY,
            url TEXT NOT NULL,
            expected_status INTEGER NOT NULL DEFAULT 200,
            timeout_s REAL NOT NULL DEFAULT 10,
            updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        )
        """
    )
    conn.commit()
    return conn


def _normalize_url(raw_url: str) -> str:
    url = raw_url.strip()
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError(f"invalid url: {raw_url!r} (expected http(s) absolute URL)")
    return url


def _resolve_intent(raw_intent: Any) -> tuple[str, str]:
    if not isinstance(raw_intent, str) or not raw_intent.strip():
        raise ValueError("intent must be a non-empty string")

    normalized_intent = raw_intent.strip().lower()
    operation = INTENT_ALIASES.get(normalized_intent)

    if operation is None:
        collapsed_intent = re.sub(r"[^a-z0-9._-]+", "", normalized_intent)
        operation = INTENT_ALIASES.get(collapsed_intent)

    if operation is None:
        for alias in sorted(INTENT_ALIASES.keys(), key=len, reverse=True):
            if alias and alias in normalized_intent:
                operation = INTENT_ALIASES[alias]
                break

    if operation is None:
        raise ValueError(f"unsupported intent: {raw_intent}")

    return normalized_intent, operation


def _register_endpoint(conn: sqlite3.Connection, payload: dict[str, Any]) -> dict[str, Any]:
    name = str(payload["name"]).strip()
    url = _normalize_url(str(payload["url"]))
    expected_status = int(payload.get("expected_status", 200))
    timeout_s = float(payload.get("timeout_s") or os.getenv("HTTP_PROBE_TIMEOUT_S") or 10)

    if not name:
        raise ValueError("name is empty")
    if expected_status < 100 or expected_status > 599:
        raise ValueError("expected_status must be between 100 and 599")
    if timeout_s <= 0:
        raise ValueError("timeout_s must be > 0")

    conn.execute(
        """
        INSERT INTO http_probe_endpoints(name, url, expected_status, timeout_s, updated_at)
        VALUES(?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        ON CONFLICT(name) DO UPDATE SET
            url=excluded.url,
            expected_status=excluded.expected_status,
            timeout_s=excluded.timeout_s,
            updated_at=excluded.updated_at
        """,
        (name, url, expected_status, timeout_s),
    )
    conn.commit()
    return {
        "saved_endpoint": name,
        "url": url,
        "expected_status": expected_status,
        "timeout_s": timeout_s,
    }


def _list_endpoints(conn: sqlite3.Connection) -> dict[str, Any]:
    rows = conn.execute(
        """
        SELECT name, url, expected_status, timeout_s, updated_at
        FROM http_probe_endpoints
        ORDER BY name
        """
    ).fetchall()
    endpoints = [dict(row) for row in rows]
    return {
        "count": len(endpoints),
        "endpoints": endpoints,
    }


def _run_probe(url: str, timeout_s: float) -> tuple[int | None, str | None, float]:
    started = time.perf_counter()
    req = request.Request(url, method="GET")
    try:
        with request.urlopen(req, timeout=timeout_s) as response:
            status = int(getattr(response, "status", 200))
            elapsed_ms = (time.perf_counter() - started) * 1000
            return status, None, round(elapsed_ms, 2)
    except error.HTTPError as exc:
        elapsed_ms = (time.perf_counter() - started) * 1000
        return int(exc.code), exc.reason, round(elapsed_ms, 2)
    except error.URLError as exc:
        elapsed_ms = (time.perf_counter() - started) * 1000
        return None, str(exc.reason), round(elapsed_ms, 2)


def _check_endpoint(conn: sqlite3.Connection, payload: dict[str, Any]) -> dict[str, Any]:
    name = str(payload["name"]).strip()
    if not name:
        raise ValueError("name is empty")

    row = conn.execute(
        """
        SELECT name, url, expected_status, timeout_s
        FROM http_probe_endpoints
        WHERE name = ?
        """,
        (name,),
    ).fetchone()
    if row is None:
        raise ValueError(f"unknown endpoint: {name}")

    endpoint = dict(row)
    status, error_message, elapsed_ms = _run_probe(endpoint["url"], float(endpoint["timeout_s"]))
    ok = status == int(endpoint["expected_status"])

    return {
        "endpoint": endpoint,
        "probe": {
            "ok": ok,
            "status": status,
            "error": error_message,
            "elapsed_ms": elapsed_ms,
        },
    }


def _describe(conn: sqlite3.Connection) -> dict[str, Any]:
    rows = conn.execute(
        "SELECT name, url, expected_status, timeout_s, updated_at FROM http_probe_endpoints ORDER BY name"
    ).fetchall()
    return {
        "tool": "http_probe",
        "db_path": str(_db_path()),
        "intents": [
            "registry.register_endpoint",
            "list.endpoints",
            "check.endpoint",
            "inspect.describe",
        ],
        "operations": [
            "register_endpoint",
            "list_endpoints",
            "check_endpoint",
            "describe",
        ],
        "known_endpoints": [dict(row) for row in rows],
    }


def main() -> int:
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        raw_intent = payload.get("intent")
        if not isinstance(raw_intent, str) or not raw_intent.strip():
            raw_intent = payload.get("operation")
        if not isinstance(raw_intent, str) or not raw_intent.strip():
            raw_intent = payload.get("mode")

        normalized_intent, operation = _resolve_intent(raw_intent)

        with _connect() as conn:
            if operation == "register_endpoint":
                result = _register_endpoint(conn, payload)
            elif operation == "list_endpoints":
                result = _list_endpoints(conn)
            elif operation == "check_endpoint":
                result = _check_endpoint(conn, payload)
            elif operation == "describe":
                result = _describe(conn)
            else:
                raise ValueError(f"unsupported operation: {operation}")
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        return 1

    print(
        json.dumps(
            {
                "intent": operation,
                "operation": operation,
                "requested_intent": normalized_intent,
                "result": result,
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
