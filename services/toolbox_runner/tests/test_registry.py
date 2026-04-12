import json

from services.toolbox_runner import registry as registry_module
from services.toolbox_runner.registry import build_registry


def test_build_registry_ok() -> None:
    registry = build_registry()
    assert "example_echo" in registry


def test_build_registry_falls_back_to_registry_file_when_no_manifests(tmp_path, monkeypatch) -> None:
    expected = {"npm_service": {"name": "npm_service", "entrypoint": "tool.py"}}
    fallback_file = tmp_path / "tools.registry.json"
    fallback_file.write_text(json.dumps(expected), encoding="utf-8")

    monkeypatch.setattr(registry_module, "TOOLS_DIR", tmp_path / "tools")
    monkeypatch.setattr(registry_module, "REGISTRY_FILE", fallback_file)

    registry = build_registry()
    assert registry == expected


def test_build_registry_scans_nested_directories(tmp_path, monkeypatch) -> None:
    tools_dir = tmp_path / "tools"
    nested_tool_dir = tools_dir / "group" / "nested_tool"
    nested_tool_dir.mkdir(parents=True)
    manifest = {
        "name": "nested_tool",
        "description": "nested",
        "action_types": ["run_tool"],
        "entrypoint": "tool.py",
        "input_schema": {"type": "object", "properties": {}},
        "output_schema": {"type": "object", "properties": {}},
    }
    (nested_tool_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    registry_file = tmp_path / "tools.registry.json"
    monkeypatch.setattr(registry_module, "TOOLS_DIR", tools_dir)
    monkeypatch.setattr(registry_module, "REGISTRY_FILE", registry_file)

    registry = build_registry()
    assert "nested_tool" in registry
    assert registry["nested_tool"]["tool_root"] == str(nested_tool_dir)
