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
