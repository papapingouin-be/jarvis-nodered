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
    assert data["events_count_db"] == 0
    assert data["traces_count_db"] == 0
    assert data["last_event"] is None


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


def test_debug_status_uses_db_last_event_when_memory_is_empty(monkeypatch, tmp_path) -> None:
    client = _client(monkeypatch, tmp_path)

    push = client.post(
        "/api/trace/event",
        json={
            "trace_id": "trace-db-fallback",
            "tool": "npm_service",
            "phase": "entry",
            "status": "ok",
        },
    )
    assert push.status_code == 200
    app_module.reset_ingestion_stats()

    status = client.get("/api/debug/status")
    assert status.status_code == 200
    payload = status.json()
    assert payload["events_count_db"] == 1
    assert payload["last_event_db"] is not None
    assert payload["last_received_event_memory"] is None
    assert payload["last_event"] is not None
    assert payload["last_event"]["trace_id"] == "trace-db-fallback"


def test_debug_status_diagnosis_distinguishes_existing_db_events(monkeypatch, tmp_path) -> None:
    client = _client(monkeypatch, tmp_path)

    client.post(
        "/api/trace/event",
        json={
            "trace_id": "trace-existing-db",
            "tool": "npm_service",
            "phase": "entry",
            "status": "ok",
        },
    )
    app_module.reset_ingestion_stats()

    status = client.get("/api/debug/status")
    assert status.status_code == 200
    messages = [item["message"] for item in status.json()["diagnosis"]]
    assert "Aucune trace reçue depuis le démarrage." not in messages
    assert any("Des traces existent en base" in message for message in messages)


def test_probe_send_test_trace_relays_to_toolbox(monkeypatch, tmp_path) -> None:
    client = _client(monkeypatch, tmp_path)

    def fake_http_json(url: str, **kwargs):
        assert url.endswith("/debug/send-test-trace")
        return 200, {"ok": True, "sent": True}, None, 8.4

    monkeypatch.setattr(app_module, "http_json", fake_http_json)
    response = client.post("/api/probes/send-test-trace")
    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is True
    assert payload["http_status"] == 200


def test_ingest_status_endpoint(monkeypatch, tmp_path) -> None:
    client = _client(monkeypatch, tmp_path)

    status = client.get("/api/debug/ingest-status")
    assert status.status_code == 200
    data = status.json()
    assert data["service"] == "jarvis_debug_studio"
    assert data["received_events_since_start"] == 0
    assert data["events_count_db"] == 0
    assert data["db_exists"] in {True, False}


def test_list_tools_trace_visible_by_default_and_hide_switch(monkeypatch, tmp_path) -> None:
    client = _client(monkeypatch, tmp_path)
    client.post("/api/trace/event", json={"trace_id": "tools-list-1", "tool": "jarvis_list_tools", "phase": "request.received", "status": "ok"})

    visible = client.get("/api/traces")
    assert visible.status_code == 200
    assert any(item["trace_id"] == "tools-list-1" for item in visible.json()["items"])

    hidden = client.get("/api/traces?hide_tools_list=true")
    assert hidden.status_code == 200
    assert all(item["trace_id"] != "tools-list-1" for item in hidden.json()["items"])
    assert hidden.json()["hidden_count"] >= 1


def test_debug_raw_events_and_trace_exists(monkeypatch, tmp_path) -> None:
    client = _client(monkeypatch, tmp_path)
    trace_id = "tools-list-xyz"
    client.post("/api/trace/event", json={"trace_id": trace_id, "tool": "jarvis_list_tools", "phase": "request.received", "status": "ok"})

    raw = client.get("/api/debug/raw-events?limit=20")
    assert raw.status_code == 200
    assert any(item["trace_id"] == trace_id and item["tool"] == "jarvis_list_tools" for item in raw.json()["items"])

    exists = client.get(f"/api/debug/trace-exists/{trace_id}")
    assert exists.status_code == 200
    payload = exists.json()
    assert payload["exists_in_events"] is True
    assert payload["appears_in_api_traces"] is True
