from __future__ import annotations

import json
import os
import py_compile
import sqlite3
import subprocess
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from services.common.jsonschema_utils import validate_against_schema
from services.toolbox_runner.registry import build_registry

ROOT = Path(__file__).resolve().parents[0]
REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DB = Path(os.getenv("JARVIS_INFRA_DB", str(REPO_ROOT / "jarvis" / "database" / "jarvis.db")))
DEFAULT_TOOL_TIMEOUT_S = int(os.getenv("DEVLAB_TOOL_TIMEOUT_S", os.getenv("TOOL_TIMEOUT_S", "30")))
TOOLBOX_RUNNER_URL = os.getenv("TOOLBOX_RUNNER_URL", "http://toolbox_runner:8030")
LLM_ADAPTER_URL = os.getenv("LLM_ADAPTER_URL", "http://llm_adapter:8010")

app = FastAPI(title="jarvis_devlab_backend", version="1.0")


class RunOptions(BaseModel):
    timeout_s: int = DEFAULT_TOOL_TIMEOUT_S
    store_run: bool = True
    redaction: bool = True


class ToolRunPayload(BaseModel):
    tool: str
    input: dict[str, Any] = Field(default_factory=dict)
    mode: str = Field(default="direct", pattern="^(direct|runner)$")
    db_path: str | None = None
    options: RunOptions = Field(default_factory=RunOptions)


class ValidationPayload(BaseModel):
    json_schema: dict[str, Any] = Field(alias="schema")
    payload: dict[str, Any]

    model_config = {"populate_by_name": True}


class LintPayload(BaseModel):
    code: str
    language: str = "python"
    filename: str = "snippet.py"


class ExplainPayload(BaseModel):
    run: dict[str, Any] | None = None
    trace: dict[str, Any] | None = None
    question: str | None = None


class DbPathPayload(BaseModel):
    db_path: str | None = None
    table: str | None = None
    limit: int = 100
    offset: int = 0


class ProxyExplainPayload(BaseModel):
    logs: list[dict[str, Any]] = Field(default_factory=list)


def db_path_or_default(value: str | None) -> Path:
    return Path(value or DEFAULT_DB)



def connect_db(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS devlab_runs (
            run_id TEXT PRIMARY KEY,
            tool_name TEXT NOT NULL,
            mode TEXT NOT NULL,
            status TEXT NOT NULL,
            started_at TEXT NOT NULL,
            ended_at TEXT,
            duration_ms INTEGER NOT NULL,
            summary TEXT,
            input_json TEXT NOT NULL,
            output_json TEXT,
            trace_json TEXT NOT NULL,
            diagnostics_json TEXT NOT NULL
        )
        """
    )
    conn.commit()
    return conn



def utc_ts() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())



def build_trace(tool: str, mode: str, tool_input: dict[str, Any], db_path: str, manifest: dict[str, Any] | None) -> dict[str, Any]:
    return {
        "trace_version": "1.0",
        "run": {
            "tool": tool,
            "mode": mode,
            "db_path": db_path,
            "started_at": utc_ts(),
            "status": "running",
        },
        "artifacts": {
            "input": tool_input,
            "output": None,
            "stderr": "",
        },
        "spans": [
            {
                "id": "validate",
                "name": "validate_input",
                "status": "running",
                "t0_ms": 0,
                "t1_ms": None,
                "data": {
                    "required": (manifest or {}).get("input_schema", {}).get("required", []),
                },
            }
        ],
        "diagnostics": [],
    }



def finish_span(trace: dict[str, Any], span_id: str, status: str, t1_ms: int, data: dict[str, Any] | None = None, error: dict[str, Any] | None = None) -> None:
    for span in trace["spans"]:
        if span["id"] == span_id:
            span["status"] = status
            span["t1_ms"] = t1_ms
            if data:
                span["data"].update(data)
            if error:
                span["error"] = error
            return



def add_span(trace: dict[str, Any], span_id: str, name: str, status: str, t0_ms: int, t1_ms: int | None = None, data: dict[str, Any] | None = None, error: dict[str, Any] | None = None) -> None:
    span = {"id": span_id, "name": name, "status": status, "t0_ms": t0_ms, "t1_ms": t1_ms, "data": data or {}}
    if error:
        span["error"] = error
    trace["spans"].append(span)



def redact_json(value: Any) -> Any:
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            if any(token in k.upper() for token in ["SECRET", "PASSWORD", "TOKEN"]):
                out[k] = "***"
            else:
                out[k] = redact_json(v)
        return out
    if isinstance(value, list):
        return [redact_json(v) for v in value]
    return value



def detect_diagnostics(tool: str, tool_input: dict[str, Any], trace: dict[str, Any], output: dict[str, Any] | None, stderr: str) -> list[dict[str, str]]:
    diagnostics: list[dict[str, str]] = []
    if tool == "npm_service" and tool_input.get("operation") == "list_services" and not tool_input.get("instance_name"):
        diagnostics.append({
            "level": "error",
            "title": "instance_name manquant",
            "message": "Le manifest npm_service exige instance_name pour list_services.",
        })
    if tool == "npm_service":
        base_urls = []
        for span in trace.get("spans", []):
            data = span.get("data", {})
            for key in ["base_url", "base_url_raw", "request_url"]:
                value = data.get(key)
                if isinstance(value, str):
                    base_urls.append(value)
        if any("/api/api/" in url for url in base_urls):
            diagnostics.append({
                "level": "warning",
                "title": "URL NPM incohérente",
                "message": "Une URL contient /api/api/. Fixe la convention NPM_URL ou la concaténation côté tool.",
            })
        if any(url.rstrip("/").endswith("/api") for url in base_urls):
            diagnostics.append({
                "level": "info",
                "title": "NPM_URL termine par /api",
                "message": "Ton code npm_service ajoute lui-même /api/... pour certains appels. Vérifie l’homogénéité.",
            })
    if stderr:
        diagnostics.append({
            "level": "warning",
            "title": "stderr non vide",
            "message": stderr[:300],
        })
    if output and isinstance(output, dict):
        msg = json.dumps(output)
        if "missing npm secret" in msg:
            diagnostics.append({
                "level": "error",
                "title": "Secret NPM absent",
                "message": "Le tool n’a pas trouvé le secret attendu dans sensitive_values.",
            })
        if "tool not found" in msg:
            diagnostics.append({
                "level": "error",
                "title": "Tool introuvable",
                "message": "Le registry du runner n’a pas trouvé l’outil demandé.",
            })
    return diagnostics



def store_run(conn: sqlite3.Connection, run_id: str, payload: ToolRunPayload, status: str, started_at: str, duration_ms: int, output: Any, trace: dict[str, Any], diagnostics: list[dict[str, Any]]) -> None:
    summary = f"{payload.tool} {payload.mode} {status}"
    conn.execute(
        """
        INSERT OR REPLACE INTO devlab_runs(
            run_id, tool_name, mode, status, started_at, ended_at, duration_ms,
            summary, input_json, output_json, trace_json, diagnostics_json
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            run_id,
            payload.tool,
            payload.mode,
            status,
            started_at,
            utc_ts(),
            duration_ms,
            summary,
            json.dumps(redact_json(payload.input), ensure_ascii=False),
            json.dumps(redact_json(output), ensure_ascii=False),
            json.dumps(redact_json(trace), ensure_ascii=False),
            json.dumps(diagnostics, ensure_ascii=False),
        ),
    )
    conn.commit()



def _load_manifest(tool_name: str) -> dict[str, Any]:
    registry = build_registry()
    manifest = registry.get(tool_name)
    if not manifest:
        raise HTTPException(status_code=404, detail=f"Tool introuvable: {tool_name}")
    return manifest



def run_direct(manifest: dict[str, Any], payload: ToolRunPayload, trace: dict[str, Any]) -> tuple[Any, str]:
    entrypoint = Path(manifest["tool_root"]) / manifest["entrypoint"]
    env = os.environ.copy()
    env["JARVIS_INFRA_DB"] = payload.db_path or str(DEFAULT_DB)
    started = time.perf_counter()
    add_span(trace, "execute", "execute_tool_direct", "running", 2, data={"entrypoint": str(entrypoint), "timeout_s": payload.options.timeout_s})
    completed = subprocess.run(
        ["python", str(entrypoint)],
        input=json.dumps(payload.input),
        text=True,
        capture_output=True,
        timeout=payload.options.timeout_s,
        env=env,
        check=False,
    )
    elapsed = int((time.perf_counter() - started) * 1000)
    if completed.returncode != 0:
        finish_span(trace, "execute", "failed", elapsed, data={"returncode": completed.returncode}, error={"type": "TOOL_CRASH", "message": completed.stderr.strip() or completed.stdout.strip()})
        return {"error": completed.stderr.strip() or completed.stdout.strip() or "tool crashed"}, completed.stderr.strip()
    try:
        data = json.loads(completed.stdout or "{}")
    except json.JSONDecodeError:
        finish_span(trace, "execute", "failed", elapsed, error={"type": "INVALID_JSON", "message": "Sortie non JSON"})
        return {"error": "tool returned non-json output", "stdout": completed.stdout}, completed.stderr.strip()
    finish_span(trace, "execute", "ok", elapsed, data={"stdout_size": len(completed.stdout)})
    return data, completed.stderr.strip()



def run_via_runner(payload: ToolRunPayload, trace: dict[str, Any]) -> tuple[Any, str]:
    started = time.perf_counter()
    add_span(trace, "execute", "execute_tool_runner", "running", 2, data={"runner_url": TOOLBOX_RUNNER_URL})
    try:
        response = httpx.post(
            f"{TOOLBOX_RUNNER_URL.rstrip('/')}/v1/run",
            json={"tool": payload.tool, "input": payload.input},
            timeout=payload.options.timeout_s,
        )
        elapsed = int((time.perf_counter() - started) * 1000)
        data = response.json()
    except Exception as exc:
        elapsed = int((time.perf_counter() - started) * 1000)
        finish_span(trace, "execute", "failed", elapsed, error={"type": "RUNNER_CONNECT_ERROR", "message": str(exc)})
        return {"error": str(exc), "ok": False}, ""
    if response.status_code >= 400 or not data.get("ok", False):
        finish_span(trace, "execute", "failed", elapsed, data={"http_status": response.status_code}, error={"type": data.get("error_code", "RUNNER_ERROR"), "message": data.get("message", "runner failed")})
        return data, ""
    finish_span(trace, "execute", "ok", elapsed, data={"http_status": response.status_code})
    return data, ""


@app.get("/health")
def health() -> dict[str, Any]:
    registry = build_registry()
    return {
        "status": "ok",
        "toolbox_runner_url": TOOLBOX_RUNNER_URL,
        "llm_adapter_url": LLM_ADAPTER_URL,
        "default_db": str(DEFAULT_DB),
        "repo_root": str(REPO_ROOT),
        "tools_count": len(registry),
        "tools": sorted(registry.keys()),
    }


@app.post("/validate")
def validate(payload: ValidationPayload) -> dict[str, Any]:
    try:
        validate_against_schema(payload.json_schema, payload.payload)
        return {"ok": True, "valid": True, "errors": []}
    except Exception as exc:
        return {"ok": True, "valid": False, "errors": [str(exc)]}


@app.post("/lint")
def lint(payload: LintPayload) -> dict[str, Any]:
    if payload.language == "json":
        try:
            json.loads(payload.code)
            return {"ok": True, "valid": True, "issues": []}
        except json.JSONDecodeError as exc:
            return {"ok": True, "valid": False, "issues": [{"line": exc.lineno, "column": exc.colno, "message": exc.msg}]}
    if payload.language == "javascript":
        # vérification syntaxique légère côté serveur sans Node
        if payload.code.count("{") != payload.code.count("}"):
            return {"ok": True, "valid": False, "issues": [{"message": "Accolades déséquilibrées"}]}
        return {"ok": True, "valid": True, "issues": []}
    with tempfile.TemporaryDirectory() as tmpdir:
        path = Path(tmpdir) / payload.filename
        path.write_text(payload.code, encoding="utf-8")
        try:
            py_compile.compile(str(path), doraise=True)
            return {"ok": True, "valid": True, "issues": []}
        except py_compile.PyCompileError as exc:
            return {"ok": True, "valid": False, "issues": [{"message": str(exc)}]}


@app.post("/run")
def run_tool(payload: ToolRunPayload) -> dict[str, Any]:
    manifest = _load_manifest(payload.tool)
    db_path = str(db_path_or_default(payload.db_path))
    run_id = f"run_{uuid.uuid4().hex[:12]}"
    started_at = utc_ts()
    t0 = time.perf_counter()
    trace = build_trace(payload.tool, payload.mode, payload.input, db_path, manifest)
    try:
        validate_against_schema(manifest["input_schema"], payload.input)
        finish_span(trace, "validate", "ok", 1)
    except Exception as exc:
        finish_span(trace, "validate", "failed", 1, error={"type": "VALIDATION_ERROR", "message": str(exc)})
        trace["run"]["status"] = "failed"
        output = {"error": str(exc)}
        diagnostics = detect_diagnostics(payload.tool, payload.input, trace, output, "")
        with connect_db(db_path_or_default(payload.db_path)) as conn:
            if payload.options.store_run:
                store_run(conn, run_id, payload, "failed", started_at, int((time.perf_counter() - t0) * 1000), output, trace, diagnostics)
        return {"ok": False, "run_id": run_id, "status": "failed", "output": output, "trace": trace, "diagnostics": diagnostics}

    add_span(trace, "db", "db_probe", "ok", 1, 2, data={"db_path": db_path})
    if payload.mode == "runner":
        output, stderr = run_via_runner(payload, trace)
    else:
        output, stderr = run_direct(manifest, payload, trace)
    trace["artifacts"]["output"] = output
    trace["artifacts"]["stderr"] = stderr
    trace["run"]["ended_at"] = utc_ts()
    status = "ok" if not (isinstance(output, dict) and output.get("error")) and not (isinstance(output, dict) and output.get("ok") is False) else "failed"
    trace["run"]["status"] = status
    diagnostics = detect_diagnostics(payload.tool, payload.input, trace, output, stderr)
    elapsed_ms = int((time.perf_counter() - t0) * 1000)
    with connect_db(db_path_or_default(payload.db_path)) as conn:
        if payload.options.store_run:
            store_run(conn, run_id, payload, status, started_at, elapsed_ms, output, trace, diagnostics)
    return {"ok": status == "ok", "run_id": run_id, "status": status, "output": output, "trace": trace, "diagnostics": diagnostics}


@app.post("/db/tables")
def db_tables(payload: DbPathPayload) -> dict[str, Any]:
    with connect_db(db_path_or_default(payload.db_path)) as conn:
        rows = conn.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall()
    return {"ok": True, "tables": [r[0] for r in rows]}


@app.post("/db/table")
def db_table(payload: DbPathPayload) -> dict[str, Any]:
    if not payload.table:
        raise HTTPException(status_code=400, detail="table requis")
    with connect_db(db_path_or_default(payload.db_path)) as conn:
        columns = [r[1] for r in conn.execute(f"PRAGMA table_info({payload.table})").fetchall()]
        rows = conn.execute(f'SELECT * FROM "{payload.table}" LIMIT ? OFFSET ?', (payload.limit, payload.offset)).fetchall()
    return {"ok": True, "columns": columns, "rows": [dict(r) for r in rows]}


@app.post("/runs/list")
def runs_list(payload: DbPathPayload) -> dict[str, Any]:
    with connect_db(db_path_or_default(payload.db_path)) as conn:
        rows = conn.execute("SELECT run_id, tool_name, mode, status, started_at, ended_at, duration_ms, summary FROM devlab_runs ORDER BY started_at DESC LIMIT ? OFFSET ?", (payload.limit, payload.offset)).fetchall()
    return {"ok": True, "items": [dict(r) for r in rows]}


@app.get("/runs/{run_id}")
def runs_get(run_id: str, db_path: str | None = None) -> dict[str, Any]:
    with connect_db(db_path_or_default(db_path)) as conn:
        row = conn.execute("SELECT * FROM devlab_runs WHERE run_id = ?", (run_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="run introuvable")
    data = dict(row)
    for key in ["input_json", "output_json", "trace_json", "diagnostics_json"]:
        data[key] = json.loads(data[key]) if data.get(key) else None
    return {"ok": True, "item": data}


@app.post("/llm/explain")
def llm_explain(payload: ExplainPayload) -> dict[str, Any]:
    heuristics = []
    trace = payload.trace or {}
    diagnostics = trace.get("diagnostics", [])
    for item in diagnostics:
        heuristics.append(item.get("message"))
    for span in trace.get("spans", []):
        if span.get("status") == "failed":
            heuristics.append(f"Étape en échec: {span.get('name')} — {span.get('error', {}).get('message', 'erreur inconnue')}")
    summary = "\n".join([h for h in heuristics if h]) or "Aucune heuristique locale forte."
    try:
        response = httpx.post(f"{LLM_ADAPTER_URL.rstrip('/')}/v1/summarize_logs", json={"logs": diagnostics or trace.get("spans", [])}, timeout=20)
        response.raise_for_status()
        llm = response.json()
    except Exception:
        llm = {"summary": summary}
    return {
        "ok": True,
        "heuristics": heuristics,
        "llm": llm,
        "advice": [
            "Teste d’abord le tool en mode direct.",
            "Vérifie la DB et les secrets attendus par le tool.",
            "Compare le résultat direct avec le mode runner pour isoler la couche fautive.",
        ],
    }
