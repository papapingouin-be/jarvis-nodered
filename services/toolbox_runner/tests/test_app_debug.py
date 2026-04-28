import os

from fastapi.testclient import TestClient

from services.toolbox_runner import app as toolbox_app


def test_debug_trace_config_reports_env(monkeypatch) -> None:
    monkeypatch.setenv("TRACE_ENABLED", "true")
    monkeypatch.setenv("TRACE_GATEWAY_URL", "http://jarvis_debug_studio:8060")
    client = TestClient(toolbox_app.app)

    response = client.get("/debug/trace-config")
    assert response.status_code == 200
    payload = response.json()
    assert payload["service"] == "toolbox_runner"
    assert payload["trace_enabled"] is True
    assert payload["trace_gateway_url"] == "http://jarvis_debug_studio:8060"
    assert payload["env_present"]["TRACE_ENABLED"] is True
    assert payload["env_present"]["TRACE_GATEWAY_URL"] is True


def test_debug_send_test_trace_returns_failure_when_disabled(monkeypatch) -> None:
    monkeypatch.setenv("TRACE_ENABLED", "false")
    monkeypatch.setenv("TRACE_GATEWAY_URL", "http://jarvis_debug_studio:8060")
    client = TestClient(toolbox_app.app)

    response = client.post("/debug/send-test-trace")
    assert response.status_code == 200
    payload = response.json()
    assert payload["sent"] is False
    assert payload["error"] == "TRACE_ENABLED=false"


def test_debug_run_npm_with_trace_uses_execute_path(monkeypatch) -> None:
    monkeypatch.setenv("TRACE_ENABLED", "false")
    monkeypatch.setattr(
        toolbox_app,
        "_execute_tool_with_trace",
        lambda tool, tool_input, context: ({"ok": True, "tool": tool, "data": tool_input}, type("T", (), {"trace_id": context["trace_id"], "last_send_result": {"sent": False}})()),
    )

    client = TestClient(toolbox_app.app)
    response = client.post("/debug/run-npm-with-trace")
    assert response.status_code == 200
    payload = response.json()
    assert payload["trace_id"] == "debug-npm-direct"
    assert payload["result"]["tool"] == "npm_service"


def test_debug_real_calls_returns_items(monkeypatch, tmp_path) -> None:
    log_file = tmp_path / "real_calls.log"
    monkeypatch.setattr(toolbox_app, "REAL_CALLS_LOG_PATH", log_file)
    client = TestClient(toolbox_app.app)

    post = client.post("/v1/run", json={"tool": "example_echo", "input": {"message": "hello"}, "context": {"trace_id": "t-real"}})
    assert post.status_code == 200

    response = client.get("/debug/real-calls")
    assert response.status_code == 200
    payload = response.json()
    assert payload["count"] >= 1
    assert payload["items"][-1]["marker"] == "REAL_TOOLBOX_RUN_CALLED"
    assert payload["items"][-1]["trace_id"] == "t-real"


def test_debug_run_nonce_calls_tool(monkeypatch) -> None:
    monkeypatch.setattr(
        toolbox_app,
        "_execute_tool",
        lambda tool, tool_input, context: {"ok": True, "tool": tool, "data": {"nonce": "x", "source": "real_toolbox_runner"}},
    )
    client = TestClient(toolbox_app.app)
    response = client.post("/debug/run-nonce")
    assert response.status_code == 200
    payload = response.json()
    assert payload["result"]["tool"] == "debug_nonce"
    assert payload["result"]["data"]["source"] == "real_toolbox_runner"


def test_openwebui_debug_nonce_calls_real_wrapper(monkeypatch, tmp_path) -> None:
    log_file = tmp_path / "real_calls.log"
    monkeypatch.setattr(toolbox_app, "REAL_CALLS_LOG_PATH", log_file)
    monkeypatch.setattr(
        toolbox_app,
        "_execute_tool",
        lambda tool, tool_input, context: {"ok": True, "tool": tool, "data": {"nonce": "JARVIS-RUNTIME-123", "source": "real_toolbox_runner"}},
    )
    client = TestClient(toolbox_app.app)

    response = client.post("/openwebui/debug_nonce", json={"input": {}, "context": {"trace_id": "owui-nonce"}})
    assert response.status_code == 200
    payload = response.json()
    assert payload == {"nonce": "JARVIS-RUNTIME-123", "source": "real_toolbox_runner"}

    calls = client.get("/debug/real-calls").json()["items"]
    assert calls[-1]["tool"] == "debug_nonce"
    assert calls[-1]["trace_id"] == "owui-nonce"


def test_openwebui_npm_service_list_calls_real_wrapper(monkeypatch, tmp_path) -> None:
    log_file = tmp_path / "real_calls.log"
    monkeypatch.setattr(toolbox_app, "REAL_CALLS_LOG_PATH", log_file)
    monkeypatch.setattr(
        toolbox_app,
        "_execute_tool",
        lambda tool, tool_input, context: {"ok": True, "tool": tool, "data": {"services": ["a", "b"]}},
    )
    client = TestClient(toolbox_app.app)

    response = client.post("/openwebui/npm_service_list", json={"input": {}, "context": {"trace_id": "owui-npm"}})
    assert response.status_code == 200
    payload = response.json()
    assert payload == {"services": ["a", "b"]}

    calls = client.get("/debug/real-calls").json()["items"]
    assert calls[-1]["tool"] == "npm_service"
    assert calls[-1]["input"]["intent"] == "list.services"
    assert calls[-1]["trace_id"] == "owui-npm"


def test_openwebui_routes_present_in_openapi() -> None:
    client = TestClient(toolbox_app.app)
    response = client.get("/openapi.json")
    assert response.status_code == 200
    paths = response.json()["paths"]
    assert "/openwebui/debug_nonce" in paths
    assert "/openwebui/npm_service_list" in paths
    assert paths["/openwebui/debug_nonce"]["post"]["operationId"] == "debug_nonce"
    assert paths["/openwebui/debug_nonce"]["post"]["tags"] == ["openwebui_tools"]
    assert paths["/openwebui/npm_service_list"]["post"]["operationId"] == "npm_service_list"
    assert paths["/openwebui/npm_service_list"]["post"]["tags"] == ["openwebui_tools"]
