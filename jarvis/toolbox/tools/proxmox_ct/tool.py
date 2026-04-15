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

SERVICE_DEFINITIONS: dict[str, dict[str, Any]] = {
    "register_target": {
        "phase": "execute",
        "confirmed_required": True,
        "description": "Add or update a Proxmox target in the local SQLite registry.",
        "required_params": ["target"],
        "optional_params": [],
    },
    "register_service": {
        "phase": "execute",
        "confirmed_required": True,
        "description": "Add or update a CT service mapping to a target and CTID.",
        "required_params": ["service"],
        "optional_params": [],
    },
    "resolve_service": {
        "phase": "collect",
        "confirmed_required": False,
        "description": "Resolve a service to target + CT details with optional secret expansion.",
        "required_params": ["service_name"],
        "optional_params": ["include_secret"],
    },
    "plan_ct_action": {
        "phase": "execute",
        "confirmed_required": True,
        "description": "Prepare API request details for CT status/start/stop/restart actions.",
        "required_params": ["service_name", "action"],
        "optional_params": [],
    },
    "list_targets": {
        "phase": "collect",
        "confirmed_required": False,
        "description": "List registered Proxmox targets.",
        "required_params": [],
        "optional_params": [],
    },
    "list_services": {
        "phase": "collect",
        "confirmed_required": False,
        "description": "List registered CT services.",
        "required_params": [],
        "optional_params": [],
    },
    "describe": {
        "phase": "collect",
        "confirmed_required": False,
        "description": "Describe current tool state and known targets/services.",
        "required_params": [],
        "optional_params": [],
    },
}

METADATA_OPERATIONS = {
    "registry-doc",
    "list-services",
    "describe-service",
    "validate-service-input",
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
        CREATE TABLE IF NOT EXISTS sensitive_values (
            namespace TEXT NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            PRIMARY KEY(namespace, key)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS proxmox_targets (
            name TEXT PRIMARY KEY,
            ip TEXT NOT NULL,
            api_path TEXT NOT NULL DEFAULT '/api2/json',
            login TEXT NOT NULL,
            password TEXT,
            password_secret_key TEXT,
            node TEXT NOT NULL,
            CHECK (
                (password IS NOT NULL AND password_secret_key IS NULL)
                OR (password IS NULL AND password_secret_key IS NOT NULL)
            )
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


def _read_secret(conn: sqlite3.Connection, namespace: str, key: str) -> str:
    row = conn.execute(
        "SELECT value FROM sensitive_values WHERE namespace = ? AND key = ?",
        (namespace, key),
    ).fetchone()
    if row is None:
        raise ValueError(f"missing secret: {namespace}/{key}")
    return str(row["value"])


def _register_target(conn: sqlite3.Connection, payload: dict[str, Any]) -> dict[str, Any]:
    target = payload["target"]
    password = target.get("password")
    password_secret_key = target.get("password_secret_key")

    if bool(password) == bool(password_secret_key):
        raise ValueError("provide exactly one of target.password or target.password_secret_key")

    conn.execute(
        """
        INSERT INTO proxmox_targets(name, ip, api_path, login, password, password_secret_key, node)
        VALUES(?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
            ip=excluded.ip,
            api_path=excluded.api_path,
            login=excluded.login,
            password=excluded.password,
            password_secret_key=excluded.password_secret_key,
            node=excluded.node
        """,
        (
            target["name"],
            target["ip"],
            target.get("api_path", "/api2/json"),
            target["login"],
            password,
            password_secret_key,
            target["node"],
        ),
    )
    conn.commit()
    return {
        "saved_target": target["name"],
        "auth_mode": "secret_ref" if password_secret_key else "inline",
    }


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


def _resolve_service(
    conn: sqlite3.Connection, service_name: str, include_secret: bool
) -> dict[str, Any]:
    row = conn.execute(
        """
        SELECT
            s.name AS service_name,
            s.ctid,
            s.path,
            t.name AS target_name,
            t.ip,
            t.api_path,
            t.login,
               t.password, t.password_secret_key, t.node
        FROM ct_services s
        JOIN proxmox_targets t ON t.name = s.target_name
        WHERE s.name = ?
        """,
        (service_name,),
    ).fetchone()
    if row is None:
        raise ValueError(f"unknown service: {service_name}")

    resolved = dict(row)
    if include_secret:
        if resolved["password"] is None:
            resolved["password"] = _read_secret(conn, "proxmox", resolved["password_secret_key"])
    else:
        resolved["password"] = "***"
    return resolved


def _plan_ct_action(conn: sqlite3.Connection, service_name: str, action: str) -> dict[str, Any]:
    resolved = _resolve_service(conn, service_name, include_secret=True)
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


def _list_targets(conn: sqlite3.Connection) -> dict[str, Any]:
    rows = conn.execute(
        """
        SELECT name, ip, api_path, login, node, password_secret_key
        FROM proxmox_targets
        ORDER BY name
        """
    ).fetchall()
    return {"targets": [dict(row) for row in rows]}


def _describe(conn: sqlite3.Connection) -> dict[str, Any]:
    targets = [dict(row) for row in conn.execute("SELECT name, ip, node FROM proxmox_targets ORDER BY name").fetchall()]
    services = [dict(row) for row in conn.execute("SELECT name, target_name, ctid FROM ct_services ORDER BY name").fetchall()]
    return {
        "tool": "proxmox_ct",
        "db_path": str(_db_path()),
        "operations": [*SERVICE_DEFINITIONS.keys(), *sorted(METADATA_OPERATIONS)],
        "required_config": ["JARVIS_INFRA_DB"],
        "known_targets": targets,
        "known_services": services,
    }


def _list_services(conn: sqlite3.Connection) -> dict[str, Any]:
    rows = conn.execute(
        "SELECT name, target_name, ctid, path FROM ct_services ORDER BY name"
    ).fetchall()
    return {"services": [dict(row) for row in rows]}


def _registry_doc() -> dict[str, Any]:
    return {
        "tool": "proxmox_ct",
        "supports_registry": True,
        "capabilities": list(SERVICE_DEFINITIONS.keys()),
        "metadata": sorted(METADATA_OPERATIONS),
        "services": [
            {
                "name": name,
                "phase": conf["phase"],
                "confirmed_required": conf["confirmed_required"],
                "description": conf["description"],
            }
            for name, conf in SERVICE_DEFINITIONS.items()
        ],
    }


def _describe_service(service_name: str) -> dict[str, Any]:
    service = SERVICE_DEFINITIONS.get(service_name)
    if service is None:
        raise ValueError(f"unknown service: {service_name}")
    return {
        "name": service_name,
        **service,
    }


def _validate_service_input(payload: dict[str, Any]) -> dict[str, Any]:
    service_name = payload.get("meta_service")
    params = payload.get("params", {})
    if service_name is None:
        raise ValueError("missing field: service")
    if not isinstance(params, dict):
        raise ValueError("params must be an object")

    spec = _describe_service(service_name)
    missing_required = [key for key in spec["required_params"] if key not in params]
    optional_missing = [key for key in spec["optional_params"] if key not in params]

    return {
        "service": service_name,
        "phase": spec["phase"],
        "confirmed_required": spec["confirmed_required"],
        "known": params,
        "missing_required": missing_required,
        "optional_missing": optional_missing,
        "ready": len(missing_required) == 0,
        "summary": "Service input is complete." if len(missing_required) == 0 else "Service input is missing required fields.",
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
                result = _resolve_service(
                    conn,
                    payload["service_name"],
                    payload.get("include_secret", False),
                )
            elif operation == "plan_ct_action":
                result = _plan_ct_action(conn, payload["service_name"], payload["action"])
            elif operation == "list_targets":
                result = _list_targets(conn)
            elif operation == "list_services":
                result = _list_services(conn)
            elif operation == "describe":
                result = _describe(conn)
            elif operation == "registry-doc":
                result = _registry_doc()
            elif operation == "list-services":
                result = {"services": sorted(SERVICE_DEFINITIONS.keys())}
            elif operation == "describe-service":
                result = _describe_service(payload["meta_service"])
            elif operation == "validate-service-input":
                result = _validate_service_input(payload)
            else:
                raise ValueError(f"unsupported operation: {operation}")
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        return 1

    print(json.dumps({"operation": operation, "result": result}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
