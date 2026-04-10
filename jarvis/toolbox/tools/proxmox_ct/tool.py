#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import sqlite3
import sys
from pathlib import Path
from typing import Any

ACTION_SUFFIX = {
    "status": "status/current",
    "start": "status/start",
    "stop": "status/stop",
    "restart": "status/reboot",
}


def _db_path() -> Path:
    return Path(os.getenv("JARVIS_INFRA_DB", "/tmp/jarvis_infra.db"))


def _connect() -> sqlite3.Connection:
    path = _db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS proxmox_targets (
            name TEXT PRIMARY KEY,
            ip TEXT NOT NULL,
            api_path TEXT NOT NULL DEFAULT '/api2/json',
            login TEXT NOT NULL,
            password TEXT NOT NULL,
            node TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS ct_services (
            name TEXT PRIMARY KEY,
            target_name TEXT NOT NULL,
            ctid INTEGER NOT NULL,
            path TEXT NOT NULL,
            FOREIGN KEY(target_name) REFERENCES proxmox_targets(name)
        )
        """
    )
    conn.commit()
    return conn


def _register_target(conn: sqlite3.Connection, payload: dict[str, Any]) -> dict[str, Any]:
    target = payload["target"]
    conn.execute(
        """
        INSERT INTO proxmox_targets(name, ip, api_path, login, password, node)
        VALUES(?, ?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
            ip=excluded.ip,
            api_path=excluded.api_path,
            login=excluded.login,
            password=excluded.password,
            node=excluded.node
        """,
        (
            target["name"],
            target["ip"],
            target.get("api_path", "/api2/json"),
            target["login"],
            target["password"],
            target["node"],
        ),
    )
    conn.commit()
    return {"saved_target": target["name"]}


def _register_service(conn: sqlite3.Connection, payload: dict[str, Any]) -> dict[str, Any]:
    service = payload["service"]
    target = conn.execute(
        "SELECT name FROM proxmox_targets WHERE name = ?",
        (service["target_name"],),
    ).fetchone()
    if target is None:
        raise ValueError(f"unknown target: {service['target_name']}")

    conn.execute(
        """
        INSERT INTO ct_services(name, target_name, ctid, path)
        VALUES(?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
            target_name=excluded.target_name,
            ctid=excluded.ctid,
            path=excluded.path
        """,
        (service["name"], service["target_name"], service["ctid"], service.get("path", "/")),
    )
    conn.commit()
    return {"saved_service": service["name"]}


def _resolve_service(conn: sqlite3.Connection, service_name: str) -> dict[str, Any]:
    row = conn.execute(
        """
        SELECT s.name AS service_name, s.ctid, s.path, t.name AS target_name, t.ip, t.api_path, t.login, t.password, t.node
        FROM ct_services s
        JOIN proxmox_targets t ON t.name = s.target_name
        WHERE s.name = ?
        """,
        (service_name,),
    ).fetchone()
    if row is None:
        raise ValueError(f"unknown service: {service_name}")
    return dict(row)


def _plan_ct_action(conn: sqlite3.Connection, service_name: str, action: str) -> dict[str, Any]:
    resolved = _resolve_service(conn, service_name)
    suffix = ACTION_SUFFIX[action]
    api = (
        f"https://{resolved['ip']}{resolved['api_path']}/nodes/{resolved['node']}/lxc/{resolved['ctid']}/{suffix}"
    )
    return {
        "service": service_name,
        "target": resolved["target_name"],
        "ctid": resolved["ctid"],
        "path": resolved["path"],
        "action": action,
        "request": {
            "method": "POST" if action != "status" else "GET",
            "url": api,
            "auth": {
                "login": resolved["login"],
                "password": resolved["password"],
            },
        },
    }


def main() -> int:
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        operation = payload.get("operation")
        with _connect() as conn:
            if operation == "register_target":
                result = _register_target(conn, payload)
            elif operation == "register_service":
                result = _register_service(conn, payload)
            elif operation == "resolve_service":
                result = _resolve_service(conn, payload["service_name"])
            elif operation == "plan_ct_action":
                result = _plan_ct_action(conn, payload["service_name"], payload["action"])
            else:
                raise ValueError(f"unsupported operation: {operation}")
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        return 1

    print(json.dumps({"operation": operation, "result": result}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
