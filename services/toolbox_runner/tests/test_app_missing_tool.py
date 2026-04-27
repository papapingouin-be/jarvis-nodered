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
        lambda manifest, tool_input: {"ok": True, "tool": manifest["name"], "data": tool_input},
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
        lambda manifest, tool_input: {"ok": True, "tool": manifest["name"], "data": tool_input},
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
