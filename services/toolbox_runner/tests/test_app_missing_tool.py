from pathlib import Path

from fastapi.testclient import TestClient

from services.toolbox_runner import app as toolbox_app


def test_run_refreshes_registry_before_missing_tool_response(monkeypatch) -> None:
    monkeypatch.setattr(toolbox_app, "REGISTRY", {})

    def fake_build_registry() -> dict:
        return {
            "npm_service": {
                "name": "npm_service",
                "input_schema": {"type": "object"},
                "output_schema": {"type": "object"},
                "tool_root": ".",
                "entrypoint": "tool.py",
            }
        }

    monkeypatch.setattr(toolbox_app, "build_registry", fake_build_registry)
    monkeypatch.setattr(
        toolbox_app,
        "run_tool",
        lambda manifest, tool_input, **kwargs: {"ok": True, "tool": manifest["name"], "data": tool_input},
    )

    client = TestClient(toolbox_app.app)
    response = client.post("/v1/run", json={"tool": "npm_service", "input": {"intent": "list.services"}})
    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is True
    assert payload["tool"] == "npm_service"


def test_missing_tool_lists_available_tools(monkeypatch) -> None:
    monkeypatch.setattr(toolbox_app, "REGISTRY", {"example_echo": {"name": "example_echo"}})
    monkeypatch.setattr(toolbox_app, "build_registry", lambda: {"example_echo": {"name": "example_echo"}})

    client = TestClient(toolbox_app.app)
    response = client.post("/v1/run", json={"tool": "npm_service", "input": {"intent": "list.services"}})
    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is False
    assert payload["error_code"] == "MISSING_TOOL"
    assert payload["data"]["available_tools"] == ["example_echo"]


def test_run_without_tool_returns_helpful_validation_payload(monkeypatch) -> None:
    monkeypatch.setattr(toolbox_app, "REGISTRY", {"example_echo": {"name": "example_echo"}})
    monkeypatch.setattr(toolbox_app, "build_registry", lambda: {"example_echo": {"name": "example_echo"}})

    client = TestClient(toolbox_app.app)
    response = client.post("/v1/run", json={"input": {"intent": "list.tools"}})
    assert response.status_code == 422
    payload = response.json()
    assert payload["ok"] is False
    assert payload["error_code"] == "MISSING_REQUIRED_FIELD"
    assert payload["data"]["available_tools"] == ["example_echo"]
    assert payload["data"]["required"] == ["tool"]


def test_list_tools_endpoint_returns_registry_tool_names(monkeypatch) -> None:
    monkeypatch.setattr(
        toolbox_app,
        "REGISTRY",
        {"example_echo": {"name": "example_echo"}, "npm_service": {"name": "npm_service"}},
    )

    client = TestClient(toolbox_app.app)
    response = client.get("/v1/tools")
    assert response.status_code == 200
    payload = response.json()
    assert payload["tools"] == ["example_echo", "npm_service"]


def test_run_path_endpoint_executes_tool(monkeypatch) -> None:
    monkeypatch.setattr(
        toolbox_app,
        "REGISTRY",
        {
            "example_echo": {
                "name": "example_echo",
                "input_schema": {"type": "object"},
                "output_schema": {"type": "object"},
                "tool_root": ".",
                "entrypoint": "tool.py",
            }
        },
    )
    monkeypatch.setattr(
        toolbox_app,
        "run_tool",
        lambda manifest, tool_input, **kwargs: {"ok": True, "tool": manifest["name"], "data": tool_input},
    )

    client = TestClient(toolbox_app.app)
    response = client.post("/v1/run/example_echo", json={"intent": "inspect.describe"})
    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is True
    assert payload["tool"] == "example_echo"
    assert payload["data"]["intent"] == "inspect.describe"


def test_run_compat_without_tool_returns_helpful_validation_payload(monkeypatch) -> None:
    monkeypatch.setattr(toolbox_app, "REGISTRY", {"example_echo": {"name": "example_echo"}})
    monkeypatch.setattr(toolbox_app, "build_registry", lambda: {"example_echo": {"name": "example_echo"}})

    client = TestClient(toolbox_app.app)
    response = client.post("/run", json={"input": {"intent": "list.tools"}})
    assert response.status_code == 422
    payload = response.json()
    assert payload["ok"] is False
    assert payload["error_code"] == "MISSING_REQUIRED_FIELD"
    assert payload["data"]["available_tools"] == ["example_echo"]


def test_list_tools_endpoint_writes_real_call_marker_and_trace_when_forced(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(
        toolbox_app,
        "REGISTRY",
        {"example_echo": {"name": "example_echo"}, "npm_service": {"name": "npm_service"}},
    )
    monkeypatch.setattr(toolbox_app, "REAL_CALLS_LOG_PATH", tmp_path / "toolbox_real_calls.log")

    captured_events: list[tuple[str, str, dict, dict]] = []

    class FakeTraceClient:
        def __init__(self, trace_id: str, run_id: str, tool: str) -> None:
            self.trace_id = trace_id
            self.run_id = run_id
            self.tool = tool

        def event(self, phase: str, status: str = "ok", *, input=None, output=None, metadata=None, **kwargs) -> None:
            captured_events.append((phase, status, input or {}, output or {}))

    monkeypatch.setattr(toolbox_app, "TraceClient", FakeTraceClient)

    client = TestClient(toolbox_app.app)
    response = client.get("/v1/tools", headers={"x-jarvis-trace-force": "true"})
    assert response.status_code == 200
    payload = response.json()
    assert payload["tools"] == ["example_echo", "npm_service"]

    lines = (tmp_path / "toolbox_real_calls.log").read_text(encoding="utf-8").strip().splitlines()
    assert lines
    assert '"marker": "REAL_TOOLBOX_LIST_TOOLS_CALLED"' in lines[-1]
    assert '"tool": "jarvis_list_tools"' in lines[-1]
    assert '"input": {}' in lines[-1]
    assert '"trace_id": "tools-list-' in lines[-1]

    assert [event[0] for event in captured_events] == [
        "request.received",
        "tool.selected",
        "code.execution.result",
        "response.returned",
    ]


def test_list_tools_endpoint_does_not_trace_by_default(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(toolbox_app, "REGISTRY", {"example_echo": {"name": "example_echo"}})
    monkeypatch.setattr(toolbox_app, "REAL_CALLS_LOG_PATH", tmp_path / "toolbox_real_calls.log")

    class FakeTraceClient:
        def __init__(self, *args, **kwargs) -> None:
            raise AssertionError("TraceClient should not be created without force header")

    monkeypatch.setattr(toolbox_app, "TraceClient", FakeTraceClient)

    client = TestClient(toolbox_app.app)
    response = client.get("/v1/tools")
    assert response.status_code == 200
    assert response.json()["tools"] == ["example_echo"]
    assert not (tmp_path / "toolbox_real_calls.log").exists()


def test_list_tools_endpoint_reuses_given_trace_id(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(toolbox_app, "REGISTRY", {"example_echo": {"name": "example_echo"}})
    monkeypatch.setattr(toolbox_app, "REAL_CALLS_LOG_PATH", tmp_path / "toolbox_real_calls.log")

    trace_ids: list[str] = []

    class FakeTraceClient:
        def __init__(self, trace_id: str, run_id: str, tool: str) -> None:
            trace_ids.append(trace_id)
            self.trace_id = trace_id
            self.run_id = run_id
            self.tool = tool

        def event(self, *args, **kwargs) -> None:
            return None

    monkeypatch.setattr(toolbox_app, "TraceClient", FakeTraceClient)

    client = TestClient(toolbox_app.app)
    response = client.get("/v1/tools", headers={"x-trace-id": "trace-fixed-123", "x-jarvis-trace-force": "true"})
    assert response.status_code == 200

    assert trace_ids == ["trace-fixed-123"]
    last_line = (tmp_path / "toolbox_real_calls.log").read_text(encoding="utf-8").strip().splitlines()[-1]
    assert '"trace_id": "trace-fixed-123"' in last_line
