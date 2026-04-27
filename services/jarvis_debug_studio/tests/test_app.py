from fastapi.testclient import TestClient

from services.jarvis_debug_studio.app import app


def test_trace_event_and_fetch(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("JARVIS_DEBUG_STUDIO_DB", str(tmp_path / "debug.db"))
    client = TestClient(app)

    response = client.post(
        "/api/trace/event",
        json={
            "trace_id": "trace-1",
            "tool": "npm_service",
            "stage": "entry",
            "payload": {"password": "secret", "input": {"intent": "list.services"}},
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
    assert payload["events"][0]["payload"]["password"] == "***"
