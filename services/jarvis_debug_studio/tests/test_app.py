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
