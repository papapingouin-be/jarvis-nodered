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
