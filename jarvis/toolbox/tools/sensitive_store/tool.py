#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import sqlite3
import sys
from pathlib import Path
from typing import Any


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
        CREATE TABLE IF NOT EXISTS sensitive_values (
            namespace TEXT NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            PRIMARY KEY(namespace, key)
        )
        """
    )
    conn.commit()
    return conn


def _set_value(conn: sqlite3.Connection, payload: dict[str, Any]) -> dict[str, Any]:
    conn.execute(
        """
        INSERT INTO sensitive_values(namespace, key, value)
        VALUES(?, ?, ?)
        ON CONFLICT(namespace, key) DO UPDATE SET
            value=excluded.value,
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        """,
        (payload["namespace"], payload["key"], payload["value"]),
    )
    conn.commit()
    return {"saved": True, "namespace": payload["namespace"], "key": payload["key"]}


def _get_value(conn: sqlite3.Connection, payload: dict[str, Any]) -> dict[str, Any]:
    row = conn.execute(
        """
        SELECT namespace, key, value, updated_at
        FROM sensitive_values
        WHERE namespace = ? AND key = ?
        """,
        (payload["namespace"], payload["key"]),
    ).fetchone()
    if row is None:
        raise ValueError(f"missing key: {payload['namespace']}/{payload['key']}")
    return dict(row)


def _list_values(conn: sqlite3.Connection, payload: dict[str, Any]) -> dict[str, Any]:
    rows = conn.execute(
        "SELECT namespace, key, updated_at FROM sensitive_values WHERE namespace = ? ORDER BY key",
        (payload["namespace"],),
    ).fetchall()
    return {"namespace": payload["namespace"], "items": [dict(row) for row in rows]}


def _delete_value(conn: sqlite3.Connection, payload: dict[str, Any]) -> dict[str, Any]:
    deleted = conn.execute(
        "DELETE FROM sensitive_values WHERE namespace = ? AND key = ?",
        (payload["namespace"], payload["key"]),
    ).rowcount
    conn.commit()
    return {"deleted": bool(deleted), "namespace": payload["namespace"], "key": payload["key"]}


def _describe(conn: sqlite3.Connection) -> dict[str, Any]:
    namespaces = [str(row["namespace"]) for row in conn.execute("SELECT DISTINCT namespace FROM sensitive_values ORDER BY namespace").fetchall()]
    return {
        "tool": "sensitive_store",
        "db_path": str(_db_path()),
        "operations": ["set", "get", "list", "delete"],
        "required_config": ["JARVIS_INFRA_DB"],
        "namespaces": namespaces,
    }


def main() -> int:
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        operation = payload.get("operation")
        with _connect() as conn:
            if operation == "set":
                result = _set_value(conn, payload)
            elif operation == "get":
                result = _get_value(conn, payload)
            elif operation == "list":
                result = _list_values(conn, payload)
            elif operation == "delete":
                result = _delete_value(conn, payload)
            elif operation == "describe":
                result = _describe(conn)
            else:
                raise ValueError(f"unsupported operation: {operation}")
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        return 1

    print(json.dumps({"operation": operation, "result": result}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
