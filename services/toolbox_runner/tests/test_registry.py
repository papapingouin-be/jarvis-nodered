from services.toolbox_runner.registry import build_registry


def test_build_registry_ok() -> None:
    registry = build_registry()
    assert "example_echo" in registry
