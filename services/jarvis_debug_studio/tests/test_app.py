from fastapi.testclient import TestClient

import services.jarvis_debug_studio.app as app_module


def _client(monkeypatch, tmp_path):
    monkeypatch.setattr(app_module, "DB_PATH", tmp_path / "debug.sqlite")
    app_module.reset_ingestion_stats()
    return TestClient(app_module.app)


def test_trace_event_and_fetch(monkeypatch, tmp_path) -> None:
    client = _client(monkeypatch, tmp_path)

    response = client.post(
        "/api/trace/event",
        json={
            "trace_id": "trace-1",
            "tool": "npm_service",
            "phase": "entry",
            "input": {"intent": "list.services", "password": "secret"},
        },
    )
    assert response.status_code == 200

    traces = client.get("/api/traces")
    assert traces.status_code == 200
    assert traces.json()["items"][0]["trace_id"] == "trace-1"

    trace = client.get("/api/traces/trace-1")
    assert trace.status_code == 200
    payload = trace.json()
    assert payload["trace_id"] == "trace-1"
    assert payload["events"][0]["input"]["password"] == "***REDACTED***"


def test_debug_status_exposes_expected_gateway(monkeypatch, tmp_path) -> None:
    client = _client(monkeypatch, tmp_path)

    status = client.get("/api/debug/status")
    assert status.status_code == 200
    data = status.json()
    assert data["configuration_expected"]["TRACE_GATEWAY_URL"] == "http://jarvis_debug_studio:8060"
    assert data["debug_studio"]["internal_port"] == 8060


def test_invalid_json_updates_ingestion_errors(monkeypatch, tmp_path) -> None:
    client = _client(monkeypatch, tmp_path)

    bad = client.post("/api/trace/event", data='{"trace_id": "x"', headers={"Content-Type": "application/json"})
    assert bad.status_code == 422

    status = client.get("/api/debug/status")
    assert status.status_code == 200
    assert status.json()["trace_ingestion"]["invalid_json_count"] >= 1


def test_trace_list_uses_latest_event_status(monkeypatch, tmp_path) -> None:
    client = _client(monkeypatch, tmp_path)

    first = client.post(
        "/api/trace/event",
        json={
            "trace_id": "trace-latest-status",
            "tool": "npm_service",
            "phase": "manual_probe.sent",
            "status": "running",
        },
    )
    assert first.status_code == 200
    second = client.post(
        "/api/trace/event",
        json={
            "trace_id": "trace-latest-status",
            "tool": "npm_service",
            "phase": "manual_probe.result",
            "status": "ok",
        },
    )
    assert second.status_code == 200

    traces = client.get("/api/traces")
    assert traces.status_code == 200
    assert traces.json()["items"][0]["status"] == "ok"


def test_trace_details_use_latest_event_status(monkeypatch, tmp_path) -> None:
    client = _client(monkeypatch, tmp_path)

    client.post(
        "/api/trace/event",
        json={
            "trace_id": "trace-details-status",
            "tool": "npm_service",
            "phase": "manual_probe.sent",
            "status": "running",
        },
    )
    client.post(
        "/api/trace/event",
        json={
            "trace_id": "trace-details-status",
            "tool": "npm_service",
            "phase": "manual_probe.result",
            "status": "ok",
        },
    )

    trace = client.get("/api/traces/trace-details-status")
    assert trace.status_code == 200
    assert trace.json()["status"] == "ok"


def test_manual_probe_updates_ingestion_stats(monkeypatch, tmp_path) -> None:
    client = _client(monkeypatch, tmp_path)

    def fake_http_json(url: str, **kwargs):
        return 200, {"ok": True, "tool": "npm_service", "result": {"services": []}}, None, 12.5

    monkeypatch.setattr(app_module, "http_json", fake_http_json)
    probe = client.post("/api/probes/npm_service/list", json={"intent": "list.services"})
    assert probe.status_code == 200
    assert probe.json()["ok"] is True

    status = client.get("/api/debug/status")
    assert status.status_code == 200
    assert status.json()["trace_ingestion"]["received_events_since_start"] >= 2


def test_ingest_status_endpoint(monkeypatch, tmp_path) -> None:
    client = _client(monkeypatch, tmp_path)

    status = client.get("/api/debug/ingest-status")
    assert status.status_code == 200
    data = status.json()
    assert data["service"] == "jarvis_debug_studio"
    assert data["received_events_since_start"] == 0
    assert data["events_count_db"] == 0
    assert data["db_exists"] in {True, False}
