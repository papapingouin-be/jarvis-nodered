from __future__ import annotations

import asyncio
import json
import os
import re
import sqlite3
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib import error, request

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

APP_DIR = Path(__file__).resolve().parent
DB_PATH = Path(os.getenv("JARVIS_DEBUG_DB", "/opt/jarvis/database/jarvis_debug_studio.sqlite"))
MAX_VALUE_LENGTH = int(os.getenv("JARVIS_DEBUG_MAX_VALUE_LENGTH", "6000"))
MAX_JSON_LENGTH = int(os.getenv("JARVIS_DEBUG_MAX_JSON_LENGTH", "120000"))
MAX_CODE_LINES = int(os.getenv("JARVIS_DEBUG_MAX_CODE_LINES", "160"))
SECRET_RE = re.compile(r"(password|secret|token|api[-_]?key|authorization|credential|bearer)", re.I)

DEFAULT_SERVICES = [
    {"name": "debug_studio", "url": "http://jarvis_debug_studio:8060/health", "type": "debug"},
    {"name": "toolbox_runner", "url": "http://toolbox_runner:8030/health", "type": "toolbox", "tools_url": "http://toolbox_runner:8030/v1/tools"},
    {"name": "llm_adapter", "url": "http://llm_adapter:8010/health", "type": "adapter"},
    {"name": "openproject_adapter", "url": "http://openproject_adapter:8020/health", "type": "adapter"},
    {"name": "git_bridge", "url": "http://git_bridge:8040/health", "type": "bridge"},
    {"name": "log_bridge", "url": "http://log_bridge:8050/health", "type": "bridge"},
    {"name": "devlab_backend", "url": "http://devlab_backend:8090/health", "type": "backend"},
]

app = FastAPI(title="Jarvis Debug Studio", version="3.0.0-control-tower")
_subscribers: set[asyncio.Queue[dict[str, Any]]] = set()
_ingestion_stats: dict[str, Any] = {}


class TraceEvent(BaseModel):
    trace_id: str = Field(min_length=1, max_length=160)
    run_id: str | None = Field(default=None, max_length=160)
    timestamp: str | None = None
    source: str = "unknown"
    service: str = "unknown"
    tool: str | None = None
    phase: str = Field(min_length=1, max_length=160)
    status: str = "ok"
    duration_ms: float | None = None
    input: Any = Field(default_factory=dict)
    output: Any = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)
    error_code: str | None = None
    error_message: str | None = None


class NpmProbeRequest(BaseModel):
    intent: str = "list.services"
    trace_id: str | None = None


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def reset_ingestion_stats() -> None:
    _ingestion_stats.clear()
    _ingestion_stats.update(
        {
            "started_at": utc_now(),
            "received_events_since_start": 0,
            "last_received_event": None,
            "last_error": None,
            "invalid_json_count": 0,
            "invalid_payload_count": 0,
        }
    )


reset_ingestion_stats()


def _record_ingested_event(event_id: int, event: TraceEvent, timestamp: str) -> None:
    _ingestion_stats["received_events_since_start"] = int(_ingestion_stats.get("received_events_since_start", 0)) + 1
    _ingestion_stats["last_received_event"] = {
        "id": event_id,
        "trace_id": event.trace_id,
        "phase": event.phase,
        "status": event.status,
        "tool": event.tool,
        "timestamp": timestamp,
    }
    _ingestion_stats["last_error"] = None


def redact(value: Any, parent_key: str = "") -> Any:
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for k, v in value.items():
            if SECRET_RE.search(str(k)):
                out[k] = "***REDACTED***"
            else:
                out[k] = redact(v, str(k))
        return out
    if isinstance(value, list):
        return [redact(v, parent_key) for v in value[:300]]
    if isinstance(value, str):
        if parent_key and SECRET_RE.search(parent_key):
            return "***REDACTED***"
        if len(value) > MAX_VALUE_LENGTH:
            return value[:MAX_VALUE_LENGTH] + f"\n...[truncated {len(value) - MAX_VALUE_LENGTH} chars]"
        return value
    return value


def normalize_code_preview(metadata: dict[str, Any]) -> dict[str, Any]:
    preview = metadata.get("code_preview")
    if isinstance(preview, str):
        lines = preview.splitlines()
        if len(lines) > MAX_CODE_LINES:
            metadata = dict(metadata)
            metadata["code_preview"] = "\n".join(lines[:MAX_CODE_LINES]) + f"\n# ...[truncated {len(lines) - MAX_CODE_LINES} lines]"
    return metadata


def dumps_limited(value: Any) -> str:
    clean = redact(value)
    raw = json.dumps(clean, ensure_ascii=False, default=str)
    if len(raw) <= MAX_JSON_LENGTH:
        return raw
    return json.dumps({"truncated": True, "preview": raw[:MAX_JSON_LENGTH], "original_size": len(raw)}, ensure_ascii=False)


def loads_json(raw: str | None) -> Any:
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except Exception:
        return {"raw": raw}


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS trace_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            trace_id TEXT NOT NULL,
            run_id TEXT,
            ts TEXT NOT NULL,
            source TEXT NOT NULL,
            service TEXT NOT NULL,
            tool TEXT,
            phase TEXT NOT NULL,
            status TEXT NOT NULL,
            duration_ms REAL,
            input_json TEXT NOT NULL,
            output_json TEXT NOT NULL,
            metadata_json TEXT NOT NULL,
            error_code TEXT,
            error_message TEXT
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_events_trace ON trace_events(trace_id, id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_events_tool ON trace_events(tool)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_events_status ON trace_events(status)")
    conn.commit()
    return conn


def explain_error(error_code: str | None, error_message: str | None) -> str | None:
    if not error_code:
        return None
    mapping = {
        "VALIDATION_ERROR": "Le JSON reçu ne respecte pas le schéma de l’outil. Vérifie surtout les champs obligatoires comme intent.",
        "MISSING_REQUIRED_FIELD": "La requête envoyée à toolbox_runner est incomplète. Il manque probablement tool, input ou context.",
        "MISSING_TOOL": "L’outil demandé n’est pas présent dans le registre toolbox_runner.",
        "TIMEOUT": "L’outil a dépassé le délai. Le script appelé est trop lent ou bloqué.",
        "TOOL_CRASH": "Le script Python a retourné un code d’erreur. Regarde stderr et le code exécuté.",
        "INVALID_JSON": "Le script a écrit autre chose que du JSON valide dans stdout.",
        "OUTPUT_VALIDATION_ERROR": "Le résultat ne respecte pas le schéma de sortie attendu.",
        "SERVICE_OFFLINE": "Le service ne répond pas à son endpoint health. Vérifie le conteneur, le port et le réseau Docker.",
    }
    base = mapping.get(error_code, "Erreur non classée. Regarde la phase, stderr et le payload détaillé.")
    if error_message:
        return f"{base}\nDétail : {error_message}"
    return base


def configured_services() -> list[dict[str, Any]]:
    raw = os.getenv("JARVIS_DEBUG_SERVICES_JSON")
    if raw:
        try:
            data = json.loads(raw)
            if isinstance(data, list):
                return data
        except Exception:
            pass
    services = list(DEFAULT_SERVICES)
    toolbox = os.getenv("TOOLBOX_RUNNER_URL")
    if toolbox:
        services = [s for s in services if s["name"] != "toolbox_runner"] + [{
            "name": "toolbox_runner",
            "url": toolbox.rstrip("/") + "/health",
            "type": "toolbox",
            "tools_url": toolbox.rstrip("/") + "/v1/tools",
        }]
    return services


def http_json(url: str, *, method: str = "GET", payload: Any | None = None, timeout: float = 1.5) -> tuple[int | None, Any, str | None, float]:
    started = time.perf_counter()
    body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = request.Request(url, data=body, method=method, headers={"Content-Type": "application/json"})
    try:
        with request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read(250_000).decode("utf-8", errors="replace")
            duration_ms = round((time.perf_counter() - started) * 1000, 2)
            try:
                return resp.status, json.loads(raw) if raw else {}, None, duration_ms
            except json.JSONDecodeError:
                return resp.status, {"raw": raw[:4000]}, None, duration_ms
    except error.HTTPError as exc:
        raw = exc.read(80_000).decode("utf-8", errors="replace")
        duration_ms = round((time.perf_counter() - started) * 1000, 2)
        try:
            data = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            data = {"raw": raw[:4000]}
        return exc.code, data, str(exc), duration_ms
    except Exception as exc:
        duration_ms = round((time.perf_counter() - started) * 1000, 2)
        return None, {}, f"{type(exc).__name__}: {exc}", duration_ms


def service_status(item: dict[str, Any]) -> dict[str, Any]:
    status_code, data, err, duration_ms = http_json(str(item["url"]), timeout=float(os.getenv("JARVIS_DEBUG_PROBE_TIMEOUT", "1.3")))
    ok = status_code is not None and 200 <= status_code < 300 and not err
    out = {
        **item,
        "status": "online" if ok else "offline",
        "http_status": status_code,
        "latency_ms": duration_ms,
        "checked_at": utc_now(),
        "response": redact(data),
        "error": err,
    }
    if item.get("tools_url") and ok:
        tools_status, tools_data, tools_err, tools_duration = http_json(str(item["tools_url"]), timeout=1.8)
        out["tools_http_status"] = tools_status
        out["tools_latency_ms"] = tools_duration
        out["tools_error"] = tools_err
        out["tools"] = tools_data.get("tools") if isinstance(tools_data, dict) else None
    return out


def db_debug_stats() -> dict[str, Any]:
    db_exists = DB_PATH.exists()
    with connect() as conn:
        events_count = int(conn.execute("SELECT COUNT(*) FROM trace_events").fetchone()[0] or 0)
        traces_count = int(conn.execute("SELECT COUNT(DISTINCT trace_id) FROM trace_events").fetchone()[0] or 0)
        last_event_at = conn.execute("SELECT MAX(ts) FROM trace_events").fetchone()[0]
    return {
        "type": "sqlite",
        "db_path": str(DB_PATH),
        "db_exists": db_exists,
        "events_count": events_count,
        "traces_count": traces_count,
        "last_event_at": last_event_at,
    }


def expected_gateway_url() -> str:
    return os.getenv("JARVIS_DEBUG_EXPECTED_TRACE_GATEWAY_URL", "http://jarvis_debug_studio:8060")


def diagnose_debug_status(storage: dict[str, Any], toolbox_check: dict[str, Any] | None = None) -> list[dict[str, str]]:
    diag: list[dict[str, str]] = []
    if _ingestion_stats["received_events_since_start"] == 0:
        diag.append(
            {
                "level": "warning",
                "message": "Aucune trace reçue depuis le démarrage.",
                "probable_cause": "toolbox_runner n’envoie pas les événements vers Jarvis Debug Studio.",
                "action": f"Vérifier TRACE_ENABLED=true et TRACE_GATEWAY_URL={expected_gateway_url()} dans toolbox_runner.",
            }
        )
    if storage["db_exists"] is False:
        diag.append(
            {
                "level": "error",
                "message": "Le fichier SQLite est introuvable.",
                "probable_cause": "Le volume /opt/jarvis/database n’est pas monté ou le chemin JARVIS_DEBUG_DB est incorrect.",
                "action": f"Créer/monter le fichier {storage['db_path']} puis redémarrer jarvis_debug_studio.",
            }
        )
    if int(_ingestion_stats.get("invalid_json_count", 0)) > 0:
        diag.append(
            {
                "level": "warning",
                "message": "Des événements ont été rejetés à cause d’un JSON invalide.",
                "probable_cause": "Le producteur envoie un body mal formé sur /api/trace/event.",
                "action": "Corriger le JSON envoyé (syntaxe + Content-Type application/json).",
            }
        )
    if int(_ingestion_stats.get("invalid_payload_count", 0)) > 0:
        diag.append(
            {
                "level": "warning",
                "message": "Des événements ont été rejetés car le payload ne respecte pas le schéma TraceEvent.",
                "probable_cause": "Champs manquants (ex: trace_id, phase) ou types incorrects.",
                "action": "Vérifier le schéma attendu côté émetteur.",
            }
        )
    if toolbox_check and not toolbox_check.get("reachable", False):
        diag.append(
            {
                "level": "error",
                "message": "toolbox_runner est injoignable depuis Jarvis Debug Studio.",
                "probable_cause": "Service toolbox_runner offline, mauvais DNS Docker ou port invalide.",
                "action": "Vérifier http://toolbox_runner:8030/health et le réseau Docker.",
            }
        )
    if not diag:
        diag.append(
            {
                "level": "ok",
                "message": "Diagnostic nominal: ingestion active.",
                "probable_cause": "Aucune anomalie critique détectée.",
                "action": "Continuer la supervision.",
            }
        )
    return diag


def add_local_debug_event(phase: str, status: str, trace_id: str, **kw: Any) -> None:
    event = TraceEvent(
        trace_id=trace_id,
        run_id=kw.pop("run_id", None),
        timestamp=utc_now(),
        source="jarvis_debug_studio",
        service="jarvis_debug_studio",
        tool=kw.pop("tool", None),
        phase=phase,
        status=status,
        input=kw.pop("input", {}),
        output=kw.pop("output", {}),
        metadata=kw.pop("metadata", {}),
        duration_ms=kw.pop("duration_ms", None),
        error_code=kw.pop("error_code", None),
        error_message=kw.pop("error_message", None),
    )
    # Reuse the same persistence path without an HTTP round-trip.
    ts = event.timestamp or utc_now()
    metadata = normalize_code_preview(redact(event.metadata))
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO trace_events(trace_id, run_id, ts, source, service, tool, phase, status,
                                     duration_ms, input_json, output_json, metadata_json,
                                     error_code, error_message)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                event.trace_id, event.run_id, ts, event.source, event.service, event.tool,
                event.phase, event.status, event.duration_ms,
                dumps_limited(event.input), dumps_limited(event.output), dumps_limited(metadata),
                event.error_code, event.error_message,
            ),
        )
        conn.commit()
        event_id = int(conn.execute("SELECT last_insert_rowid()").fetchone()[0])
    _record_ingested_event(event_id, event, ts)


@app.on_event("startup")
def startup() -> None:
    reset_ingestion_stats()
    with connect():
        pass


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    if request.url.path == "/api/trace/event":
        has_json_invalid = any((err.get("type") or "").endswith("json_invalid") for err in exc.errors())
        if has_json_invalid:
            _ingestion_stats["invalid_json_count"] = int(_ingestion_stats.get("invalid_json_count", 0)) + 1
            _ingestion_stats["last_error"] = "JSON invalide reçu sur /api/trace/event"
            print("DEBUG_STUDIO_EVENT_REJECTED error=JSON invalide reçu sur /api/trace/event")
        else:
            _ingestion_stats["invalid_payload_count"] = int(_ingestion_stats.get("invalid_payload_count", 0)) + 1
            _ingestion_stats["last_error"] = "Payload invalide reçu sur /api/trace/event"
            print("DEBUG_STUDIO_EVENT_REJECTED error=Payload invalide reçu sur /api/trace/event")
    return JSONResponse(status_code=422, content={"detail": exc.errors()})


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "service": "jarvis_debug_studio",
        "status": "online",
    }


@app.get("/api/services")
def get_services() -> dict[str, Any]:
    items = [service_status(s) for s in configured_services()]
    return {
        "items": items,
        "summary": {
            "total": len(items),
            "online": sum(1 for s in items if s["status"] == "online"),
            "offline": sum(1 for s in items if s["status"] == "offline"),
        },
        "trace_config": {
            "expected_toolbox_gateway_url": "http://jarvis_debug_studio:8060",
            "note": "Si les services sont online mais qu’aucune trace n’arrive, vérifie TRACE_ENABLED=true et TRACE_GATEWAY_URL dans toolbox_runner.",
        },
    }


@app.get("/api/tools")
def get_tools() -> dict[str, Any]:
    toolbox_url = os.getenv("TOOLBOX_RUNNER_URL", "http://toolbox_runner:8030").rstrip("/")
    status, data, err, duration_ms = http_json(toolbox_url + "/v1/tools", timeout=2.0)
    return {"ok": err is None and status and 200 <= status < 300, "http_status": status, "duration_ms": duration_ms, "data": data, "error": err}


def toolbox_connectivity_check() -> dict[str, Any]:
    health_url = "http://toolbox_runner:8030/health"
    tools_url = "http://toolbox_runner:8030/v1/tools"
    h_status, h_data, h_err, h_latency = http_json(health_url, timeout=2.5)
    t_status, t_data, t_err, t_latency = http_json(tools_url, timeout=2.5)
    tools = t_data.get("tools", []) if isinstance(t_data, dict) else []
    reachable = (
        h_err is None
        and t_err is None
        and h_status is not None
        and t_status is not None
        and 200 <= h_status < 300
        and 200 <= t_status < 300
    )
    return {
        "reachable": reachable,
        "latency_ms": {"health": h_latency, "tools": t_latency},
        "health": {"url": health_url, "http_status": h_status, "response": redact(h_data), "error": h_err},
        "tools": {"url": tools_url, "http_status": t_status, "available": tools, "error": t_err},
        "error": h_err or t_err,
    }


@app.get("/api/debug/toolbox-check")
def debug_toolbox_check() -> dict[str, Any]:
    result = toolbox_connectivity_check()
    return {"ok": result["reachable"], "service": "toolbox_runner", **result}


@app.get("/api/debug/ingest-status")
def debug_ingest_status() -> dict[str, Any]:
    storage = db_debug_stats()
    return {
        "service": "jarvis_debug_studio",
        "received_events_since_start": _ingestion_stats.get("received_events_since_start", 0),
        "last_received_event": _ingestion_stats.get("last_received_event"),
        "last_ingest_error": _ingestion_stats.get("last_error"),
        "events_count_db": storage["events_count"],
        "traces_count_db": storage["traces_count"],
        "db_path": storage["db_path"],
        "db_exists": storage["db_exists"],
    }


@app.get("/api/debug/status")
def debug_status() -> dict[str, Any]:
    storage = db_debug_stats()
    toolbox_check = toolbox_connectivity_check()
    return {
        "ok": True,
        "service": "jarvis_debug_studio",
        "debug_studio": {
            "online": True,
            "internal_port": 8060,
            "external_port_hint": 4318,
        },
        "storage": storage,
        "trace_ingestion": {
            "endpoint": "/api/trace/event",
            "received_events_since_start": _ingestion_stats["received_events_since_start"],
            "last_received_event": _ingestion_stats["last_received_event"],
            "last_error": _ingestion_stats["last_error"],
            "invalid_json_count": _ingestion_stats["invalid_json_count"],
            "invalid_payload_count": _ingestion_stats["invalid_payload_count"],
            "started_at": _ingestion_stats["started_at"],
        },
        "configuration_expected": {
            "TRACE_ENABLED": "true",
            "TRACE_GATEWAY_URL": expected_gateway_url(),
        },
        "toolbox_runner_check": toolbox_check,
        "diagnosis": diagnose_debug_status(storage, toolbox_check),
    }


@app.post("/api/probes/npm_service/list")
def probe_npm_service(req: NpmProbeRequest) -> dict[str, Any]:
    trace_id = req.trace_id or f"manual-npm-{uuid.uuid4().hex[:10]}"
    toolbox_url = os.getenv("TOOLBOX_RUNNER_URL", "http://toolbox_runner:8030").rstrip("/")
    payload = {"tool": "npm_service", "input": {"intent": req.intent}, "context": {"trace_id": trace_id, "origin": "jarvis_debug_studio.manual_probe"}}
    add_local_debug_event("manual_probe.sent", "ok", trace_id, tool="npm_service", input=payload, metadata={"target_url": toolbox_url + "/v1/run"})
    status, data, err, duration_ms = http_json(toolbox_url + "/v1/run", method="POST", payload=payload, timeout=float(os.getenv("JARVIS_DEBUG_MANUAL_PROBE_TIMEOUT", "12")))
    ok = err is None and status is not None and 200 <= status < 300 and (not isinstance(data, dict) or data.get("ok") is not False)
    add_local_debug_event(
        "manual_probe.result",
        "ok" if ok else "error",
        trace_id,
        tool="npm_service",
        output={"http_status": status, "body": data},
        duration_ms=duration_ms,
        error_code=None if ok else "SERVICE_OFFLINE" if status is None else (data.get("error_code") if isinstance(data, dict) else "HTTP_ERROR"),
        error_message=err or (data.get("message") if isinstance(data, dict) else None),
    )
    return {"ok": ok, "trace_id": trace_id, "http_status": status, "duration_ms": duration_ms, "result": data, "error": err}


@app.post("/api/trace/event")
async def post_event(event: TraceEvent) -> dict[str, Any]:
    print(
        f"DEBUG_STUDIO_EVENT_RECEIVED trace_id={event.trace_id} service={event.service} tool={event.tool} phase={event.phase}"
    )
    ts = event.timestamp or utc_now()
    metadata = normalize_code_preview(redact(event.metadata))
    row_event = event.dict()
    row_event["timestamp"] = ts
    row_event["metadata"] = metadata
    with connect() as conn:
        cur = conn.execute(
            """
            INSERT INTO trace_events(trace_id, run_id, ts, source, service, tool, phase, status,
                                     duration_ms, input_json, output_json, metadata_json,
                                     error_code, error_message)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                event.trace_id, event.run_id, ts, event.source, event.service, event.tool,
                event.phase, event.status, event.duration_ms,
                dumps_limited(event.input), dumps_limited(event.output), dumps_limited(metadata),
                event.error_code, event.error_message,
            ),
        )
        conn.commit()
        event_id = cur.lastrowid
    row_event["id"] = event_id
    row_event["explanation"] = explain_error(event.error_code, event.error_message)
    _record_ingested_event(event_id, event, ts)
    for queue in list(_subscribers):
        try:
            queue.put_nowait(row_event)
        except Exception:
            _subscribers.discard(queue)
    return {"ok": True, "id": event_id}


@app.get("/api/traces")
def list_traces(
    limit: int = Query(default=100, ge=1, le=500),
    tool: str | None = None,
    status: str | None = None,
    q: str | None = None,
) -> dict[str, Any]:
    where = []
    args: list[Any] = []
    if tool:
        where.append("tool = ?")
        args.append(tool)
    if status:
        where.append("status = ?")
        args.append(status)
    if q:
        where.append("(trace_id LIKE ? OR run_id LIKE ? OR tool LIKE ? OR phase LIKE ?)")
        like = f"%{q}%"
        args.extend([like, like, like, like])
    where_sql = "WHERE " + " AND ".join(where) if where else ""
    with connect() as conn:
        rows = conn.execute(
            f"""
            SELECT trace_id,
                   COALESCE(MAX(run_id), '') AS run_id,
                   COALESCE(MAX(tool), '') AS tool,
                   COALESCE(MAX(service), '') AS service,
                   COUNT(*) AS events,
                   MIN(ts) AS started_at,
                   MAX(ts) AS last_at,
                   ROUND(SUM(COALESCE(duration_ms, 0)), 2) AS observed_duration_ms,
                   (
                       SELECT te2.status
                       FROM trace_events te2
                       WHERE te2.trace_id = trace_events.trace_id
                       ORDER BY te2.id DESC
                       LIMIT 1
                   ) AS status,
                   MAX(error_code) AS error_code,
                   MAX(error_message) AS error_message
            FROM trace_events
            {where_sql}
            GROUP BY trace_id
            ORDER BY MAX(id) DESC
            LIMIT ?
            """,
            (*args, limit),
        ).fetchall()
    items = [dict(r) for r in rows]
    for item in items:
        item["explanation"] = explain_error(item.get("error_code"), item.get("error_message"))
    return {"items": items}


@app.get("/api/traces/{trace_id}")
def get_trace(trace_id: str) -> dict[str, Any]:
    with connect() as conn:
        rows = conn.execute("SELECT * FROM trace_events WHERE trace_id = ? ORDER BY id ASC", (trace_id,)).fetchall()
    if not rows:
        raise HTTPException(404, "trace not found")
    events: list[dict[str, Any]] = []
    for r in rows:
        d = dict(r)
        d["timestamp"] = d.pop("ts")
        d["input"] = loads_json(d.pop("input_json"))
        d["output"] = loads_json(d.pop("output_json"))
        d["metadata"] = loads_json(d.pop("metadata_json"))
        d["explanation"] = explain_error(d.get("error_code"), d.get("error_message"))
        events.append(d)
    first = events[0]
    latest_status = str(events[-1].get("status") or "ok")
    if latest_status in {"ok", "warning", "error", "running"}:
        status = latest_status
    else:
        status = "ok"
    return {"trace_id": trace_id, "tool": first.get("tool"), "status": status, "events": events}


@app.delete("/api/traces/{trace_id}")
def delete_trace(trace_id: str) -> dict[str, Any]:
    with connect() as conn:
        cur = conn.execute("DELETE FROM trace_events WHERE trace_id = ?", (trace_id,))
        conn.commit()
    return {"ok": True, "deleted_events": cur.rowcount}


@app.get("/api/live")
async def live() -> StreamingResponse:
    queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=100)
    _subscribers.add(queue)

    async def gen():
        try:
            yield "event: hello\ndata: {\"ok\": true}\n\n"
            while True:
                event = await queue.get()
                yield "event: trace\ndata: " + json.dumps(event, ensure_ascii=False, default=str) + "\n\n"
        finally:
            _subscribers.discard(queue)

    return StreamingResponse(gen(), media_type="text/event-stream")


@app.get("/")
def index() -> FileResponse:
    return FileResponse(APP_DIR / "static" / "index.html")


app.mount("/static", StaticFiles(directory=APP_DIR / "static"), name="static")
