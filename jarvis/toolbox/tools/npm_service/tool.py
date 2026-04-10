#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import sqlite3
import sys
from pathlib import Path
from typing import Any


ACTIONS = {"list", "add", "delete"}


def _db_path() -> Path:
    return Path(os.getenv("JARVIS_INFRA_DB", "/tmp/jarvis_infra.db"))


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
        CREATE TABLE IF NOT EXISTS npm_instances (
            name TEXT PRIMARY KEY,
            base_url TEXT NOT NULL,
            login TEXT NOT NULL,
            password TEXT,
            password_secret_key TEXT,
            CHECK ((password IS NOT NULL AND password_secret_key IS NULL) OR (password IS NULL AND password_secret_key IS NOT NULL))
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS npm_services (
            domain TEXT PRIMARY KEY,
            instance_name TEXT NOT NULL,
            forward_host TEXT NOT NULL,
            forward_port INTEGER NOT NULL,
            scheme TEXT NOT NULL DEFAULT 'http',
            FOREIGN KEY(instance_name) REFERENCES npm_instances(name)
        )
        """
    )
    conn.commit()
    return conn


def _read_secret(conn: sqlite3.Connection, key: str) -> str:
    row = conn.execute(
        "SELECT value FROM sensitive_values WHERE namespace = 'npm' AND key = ?",
        (key,),
    ).fetchone()
    if row is None:
        raise ValueError(f"missing npm secret: {key}")
    return str(row["value"])


def _register_instance(conn: sqlite3.Connection, payload: dict[str, Any]) -> dict[str, Any]:
    instance = payload["instance"]
    password = instance.get("password")
    password_secret_key = instance.get("password_secret_key")
    if bool(password) == bool(password_secret_key):
        raise ValueError("provide exactly one of instance.password or instance.password_secret_key")

    conn.execute(
        """
        INSERT INTO npm_instances(name, base_url, login, password, password_secret_key)
        VALUES(?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
            base_url=excluded.base_url,
            login=excluded.login,
            password=excluded.password,
            password_secret_key=excluded.password_secret_key
        """,
        (instance["name"], instance["base_url"], instance["login"], password, password_secret_key),
    )
    conn.commit()
    return {"saved_instance": instance["name"]}


def _register_service(conn: sqlite3.Connection, payload: dict[str, Any]) -> dict[str, Any]:
    service = payload["service"]
    found = conn.execute("SELECT name FROM npm_instances WHERE name = ?", (service["instance_name"],)).fetchone()
    if found is None:
        raise ValueError(f"unknown npm instance: {service['instance_name']}")

    conn.execute(
        """
        INSERT INTO npm_services(domain, instance_name, forward_host, forward_port, scheme)
        VALUES(?, ?, ?, ?, ?)
        ON CONFLICT(domain) DO UPDATE SET
            instance_name=excluded.instance_name,
            forward_host=excluded.forward_host,
            forward_port=excluded.forward_port,
            scheme=excluded.scheme
        """,
        (
            service["domain"],
            service["instance_name"],
            service["forward_host"],
            service["forward_port"],
            service.get("scheme", "http"),
        ),
    )
    conn.commit()
    return {"saved_service": service["domain"]}


def _list_services(conn: sqlite3.Connection, payload: dict[str, Any]) -> dict[str, Any]:
    rows = conn.execute(
        "SELECT domain, instance_name, forward_host, forward_port, scheme FROM npm_services WHERE instance_name = ? ORDER BY domain",
        (payload["instance_name"],),
    ).fetchall()
    return {"instance_name": payload["instance_name"], "services": [dict(row) for row in rows]}


def _plan_service_action(conn: sqlite3.Connection, payload: dict[str, Any]) -> dict[str, Any]:
    action = payload["action"]
    if action not in ACTIONS:
        raise ValueError(f"unsupported action: {action}")

    instance = conn.execute(
        "SELECT name, base_url, login, password, password_secret_key FROM npm_instances WHERE name = ?",
        (payload["instance_name"],),
    ).fetchone()
    if instance is None:
        raise ValueError(f"unknown npm instance: {payload['instance_name']}")

    inst = dict(instance)
    password = inst["password"] if inst["password"] is not None else _read_secret(conn, inst["password_secret_key"])

    plan: dict[str, Any] = {
        "instance_name": inst["name"],
        "action": action,
        "auth": {
            "login": inst["login"],
            "password": password,
        },
    }

    if action == "list":
        plan["request"] = {
            "method": "GET",
            "url": f"{inst['base_url'].rstrip('/')}/api/nginx/proxy-hosts",
        }
    else:
        service = conn.execute(
            "SELECT domain, forward_host, forward_port, scheme FROM npm_services WHERE domain = ? AND instance_name = ?",
            (payload["domain"], payload["instance_name"]),
        ).fetchone()
        if service is None:
            raise ValueError(f"unknown npm service for instance: {payload['domain']}")
        svc = dict(service)
        if action == "delete":
            plan["request"] = {
                "method": "DELETE",
                "url": f"{inst['base_url'].rstrip('/')}/api/nginx/proxy-hosts?domain={svc['domain']}",
            }
        else:
            plan["request"] = {
                "method": "POST",
                "url": f"{inst['base_url'].rstrip('/')}/api/nginx/proxy-hosts",
                "json": {
                    "domain_names": [svc["domain"]],
                    "forward_scheme": svc["scheme"],
                    "forward_host": svc["forward_host"],
                    "forward_port": svc["forward_port"],
                },
            }
            plan["service"] = svc
    return plan


def main() -> int:
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        operation = payload.get("operation")
        with _connect() as conn:
            if operation == "register_instance":
                result = _register_instance(conn, payload)
            elif operation == "register_service":
                result = _register_service(conn, payload)
            elif operation == "list_services":
                result = _list_services(conn, payload)
            elif operation == "plan_service_action":
                result = _plan_service_action(conn, payload)
            else:
                raise ValueError(f"unsupported operation: {operation}")
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        return 1

    print(json.dumps({"operation": operation, "result": result}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
