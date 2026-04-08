from services.toolbox_runner.registry import build_registry
from services.toolbox_runner.runner import ToolRunError, run_tool


def test_run_example_echo_ok() -> None:
    manifest = build_registry()["example_echo"]
    out = run_tool(manifest, {"message": "hello"})
    assert out["ok"] is True
    assert out["data"]["echo"] == "hello"


def test_run_example_echo_validation_error() -> None:
    manifest = build_registry()["example_echo"]
    try:
        run_tool(manifest, {})
        assert False
    except ToolRunError as exc:
        assert exc.code == "VALIDATION_ERROR"
