from services.toolbox_runner.runner import run_tool


def test_run_tool_emits_trace_events_for_success() -> None:
    captured = []

    def hook(stage, payload, duration_ms=None, has_error=False):
        captured.append((stage, payload, duration_ms, has_error))

    manifest = {
        "name": "example_echo",
        "tool_root": "jarvis/toolbox/tools/example_echo",
        "entrypoint": "tool.py",
        "input_schema": {
            "type": "object",
            "required": ["message"],
            "properties": {"message": {"type": "string"}},
        },
        "output_schema": {
            "type": "object",
            "required": ["echo"],
            "properties": {"echo": {"type": "string"}},
        },
    }

    result = run_tool(manifest, {"message": "hello"}, trace_hook=hook)
    assert result["ok"] is True
    stages = [item[0] for item in captured]
    assert "entry" in stages
    assert "validation" in stages
    assert "stdout" in stages
    assert "exit" in stages
