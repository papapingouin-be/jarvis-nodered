#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import sqlite3
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from urllib import error, request

ACTIONS = {"list", "add", "delete"}


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
        CREATE TABLE IF NOT EXISTS npm_instances (
            name TEXT PRIMARY KEY,
            base_url TEXT NOT NULL,
            login TEXT NOT NULL,
            password TEXT,
            password_secret_key TEXT,
            CHECK (
                (password IS NOT NULL AND password_secret_key IS NULL)
                OR (password IS NULL AND password_secret_key IS NOT NULL)
            )
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
        raise ValueError(
            "missing npm secret: "
            f"{key}. Add sensitive_values(namespace='npm', key='{key}', value='...')."
        )
    return str(row["value"])


def _normalize_base_url(base_url: str) -> str:
    trimmed = base_url.strip()
    if not trimmed:
        raise ValueError("base_url is empty")

    parsed = urlparse(trimmed)
    if not parsed.scheme or not parsed.netloc:
        raise ValueError(
            "invalid base_url: expected absolute URL like http://npm.local:81 "
            f"but received '{base_url}'"
        )
    return trimmed.rstrip("/")


def _read_value(conn: sqlite3.Connection, namespace: str, key: str) -> str | None:
    row = conn.execute(
        "SELECT value FROM sensitive_values WHERE namespace = ? AND key = ?",
        (namespace, key),
    ).fetchone()
    if row is None:
        return None
    return str(row["value"])


def _read_value_first(conn: sqlite3.Connection, namespaces: tuple[str, ...], key: str) -> str | None:
    for namespace in namespaces:
        value = _read_value(conn, namespace, key)
        if value:
            return value
    return None


def _register_instance(conn: sqlite3.Connection, payload: dict[str, Any]) -> dict[str, Any]:
    instance = payload["instance"]
    raw_password = instance.get("password")
    raw_password_secret_key = instance.get("password_secret_key")

    password = raw_password.strip() if isinstance(raw_password, str) else raw_password
    password_secret_key = (
        raw_password_secret_key.strip()
        if isinstance(raw_password_secret_key, str)
        else raw_password_secret_key
    )

    has_password = isinstance(password, str) and bool(password)
    has_password_secret_key = isinstance(password_secret_key, str) and bool(password_secret_key)

    if has_password == has_password_secret_key:
        raise ValueError(
            "provide exactly one of instance.password or instance.password_secret_key "
            f"(received password={'set' if has_password else 'missing'}, "
            f"password_secret_key={'set' if has_password_secret_key else 'missing'}). "
            "Example (inline): instance.password='***' and omit instance.password_secret_key. "
            "Example (secret ref): instance.password_secret_key='npm-admin-pass' and omit instance.password."
        )

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
        (
            instance["name"],
            instance["base_url"],
            instance["login"],
            password if has_password else None,
            password_secret_key if has_password_secret_key else None,
        ),
    )
    conn.commit()
    return {"saved_instance": instance["name"]}


def _register_service(conn: sqlite3.Connection, payload: dict[str, Any]) -> dict[str, Any]:
    service = payload["service"]
    found = conn.execute(
        "SELECT name FROM npm_instances WHERE name = ?",
        (service["instance_name"],),
    ).fetchone()
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
    instance_name = payload["instance_name"]
    rows = conn.execute(
        """
        SELECT domain, instance_name, forward_host, forward_port, scheme
        FROM npm_services
        WHERE instance_name = ?
        ORDER BY domain
        """,
        (instance_name,),
    ).fetchall()
    local_services = [dict(row) for row in rows]

    instance = _resolve_instance(conn, instance_name)
    if instance is None:
        fallback_keys = ("NPM_URL", "NPM_IDENTITY", "NPM_SECRET")
        fallback_namespaces = ("npm_service", "npm")
        fallback_values = {key: _read_value_first(conn, fallback_namespaces, key) for key in fallback_keys}
        missing_fallback_keys = [key for key, value in fallback_values.items() if not value]
        return {
            "instance_name": instance_name,
            "services": local_services,
            "remote_services": [],
            "remote_count": 0,
            "instance_configured": False,
            "instance_source": None,
            "required_fallback_namespace": "npm_service",
            "accepted_fallback_namespaces": ["npm_service", "npm"],
            "required_fallback_keys": list(fallback_keys),
            "missing_fallback_keys": missing_fallback_keys,
            "message": (
                "No NPM instance credentials found for this instance. "
                "Register one via `register_instance` or set fallback keys in "
                "`sensitive_values` namespace `npm_service` (or legacy `npm`) "
                "with NPM_URL/NPM_IDENTITY/NPM_SECRET."
            ),
        }

    inst = instance
    password = inst["password"]
    remote_services = _fetch_remote_services(inst["base_url"], inst["login"], password)
    return {
        "instance_name": instance_name,
        "services": local_services,
        "remote_services": remote_services,
        "remote_count": len(remote_services),
        "instance_configured": True,
        "instance_source": inst["source"],
    }


def _resolve_instance(conn: sqlite3.Connection, instance_name: str) -> dict[str, Any] | None:
    row = conn.execute(
        """
        SELECT name, base_url, login, password, password_secret_key
        FROM npm_instances
        WHERE name = ?
        """,
        (instance_name,),
    ).fetchone()
    if row is not None:
        inst = dict(row)
        password = (
            inst["password"]
            if inst["password"] is not None
            else _read_secret(conn, inst["password_secret_key"])
        )
        return {
            "name": inst["name"],
            "base_url": inst["base_url"],
            "login": inst["login"],
            "password": password,
            "source": "registered_instance",
        }

    # Fallback for config-web defaults: values stored by namespace `npm_service`.
    # Also accept legacy namespace `npm` for backward compatibility.
    # This allows list_services(default) to work without a prior register_instance step.
    fallback_namespaces = ("npm_service", "npm")
    base_url = _read_value_first(conn, fallback_namespaces, "NPM_URL")
    login = _read_value_first(conn, fallback_namespaces, "NPM_IDENTITY")
    password = _read_value_first(conn, fallback_namespaces, "NPM_SECRET")
    if base_url and login and password:
        return {
            "name": instance_name,
            "base_url": base_url,
            "login": login,
            "password": password,
            "source": "config_web_fallback",
        }
    return None


def _fetch_remote_services(base_url: str, login: str, password: str) -> list[dict[str, Any]]:
    normalized_base_url = _normalize_base_url(base_url)
    api_root = (
        normalized_base_url
        if normalized_base_url.endswith("/api")
        else f"{normalized_base_url}/api"
    )
    token_url = f"{api_root}/tokens"
    token_req = request.Request(
        token_url,
        data=json.dumps({"identity": login, "secret": password}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with request.urlopen(token_req, timeout=10) as response:
            token_payload = json.loads(response.read().decode("utf-8"))
    except error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")[:300]
        raise ValueError(
            "npm token request failed "
            f"(status={exc.code}, url={token_url}, reason={exc.reason}, body={body!r})"
        ) from exc
    except error.URLError as exc:
        raise ValueError(
            f"npm token request failed (url={token_url}, reason={exc.reason!r})"
        ) from exc

    token = token_payload.get("token")
    if not token:
        raise ValueError(
            "npm token request did not return a token "
            f"(url={token_url}, payload_keys={sorted(token_payload.keys())})"
        )

    hosts_url = f"{api_root}/nginx/proxy-hosts"
    hosts_req = request.Request(
        hosts_url,
        headers={"Authorization": f"Bearer {token}"},
        method="GET",
    )
    try:
        with request.urlopen(hosts_req, timeout=10) as response:
            raw_hosts = json.loads(response.read().decode("utf-8"))
    except error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")[:300]
        raise ValueError(
            "npm list request failed "
            f"(status={exc.code}, url={hosts_url}, reason={exc.reason}, body={body!r})"
        ) from exc
    except error.URLError as exc:
        raise ValueError(
            f"npm list request failed (url={hosts_url}, reason={exc.reason!r})"
        ) from exc

    if not isinstance(raw_hosts, list):
        raise ValueError(
            "npm list response is not an array "
            f"(url={hosts_url}, payload_type={type(raw_hosts).__name__})"
        )

    services: list[dict[str, Any]] = []
    for item in raw_hosts:
        if not isinstance(item, dict):
            continue
        domains = item.get("domain_names")
        if isinstance(domains, list) and domains:
            domain = str(domains[0])
        else:
            domain = str(item.get("domain", ""))
        services.append(
            {
                "id": item.get("id"),
                "domain": domain,
                "domain_names": domains if isinstance(domains, list) else [],
                "forward_host": item.get("forward_host"),
                "forward_port": item.get("forward_port"),
                "scheme": item.get("forward_scheme"),
                "enabled": item.get("enabled"),
            }
        )
    return services


def _plan_service_action(conn: sqlite3.Connection, payload: dict[str, Any]) -> dict[str, Any]:
    action = payload["action"]
    if action not in ACTIONS:
        raise ValueError(f"unsupported action: {action}")

    instance = conn.execute(
        """
        SELECT name, base_url, login, password, password_secret_key
        FROM npm_instances
        WHERE name = ?
        """,
        (payload["instance_name"],),
    ).fetchone()
    if instance is None:
        raise ValueError(f"unknown npm instance: {payload['instance_name']}")

    inst = dict(instance)
    password = (
        inst["password"]
        if inst["password"] is not None
        else _read_secret(conn, inst["password_secret_key"])
    )

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
            """
            SELECT domain, forward_host, forward_port, scheme
            FROM npm_services
            WHERE domain = ? AND instance_name = ?
            """,
            (payload["domain"], payload["instance_name"]),
        ).fetchone()
        if service is None:
            raise ValueError(f"unknown npm service for instance: {payload['domain']}")
        svc = dict(service)
        if action == "delete":
            plan["request"] = {
                "method": "DELETE",
                "url": (
                    f"{inst['base_url'].rstrip('/')}"
                    f"/api/nginx/proxy-hosts?domain={svc['domain']}"
                ),
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




def _describe(conn: sqlite3.Connection) -> dict[str, Any]:
    instances = [dict(row) for row in conn.execute("SELECT name, base_url, login FROM npm_instances ORDER BY name").fetchall()]
    services = [dict(row) for row in conn.execute("SELECT domain, instance_name, forward_host, forward_port, scheme FROM npm_services ORDER BY domain").fetchall()]
    return {
        "tool": "npm_service",
        "db_path": str(_db_path()),
        "operations": ["register_instance", "register_service", "list_services", "plan_service_action"],
        "required_config": ["JARVIS_INFRA_DB"],
        "fallback_config_namespace": "npm_service",
        "fallback_config_keys": ["NPM_URL", "NPM_IDENTITY", "NPM_SECRET"],
        "known_instances": instances,
        "known_services": services,
    }


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
