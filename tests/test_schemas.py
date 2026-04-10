import pytest

from services.common.jarvis_types import ToolRunRequest
from services.common.jsonschema_utils import SchemaValidationError, validate_payload


def test_jarvis_message_schema_valid_invalid() -> None:
    valid = {
        "channel": "openwebui",
        "user_id": "laurent",
        "conversation_id": "conv-123",
        "message_id": "msg-001",
        "text": "Créer un outil",
        "attachments": [],
        "timestamp": "2026-04-08T12:00:00Z",
        "reply_policy": "same_channel",
        "meta": {"source": "http", "raw": {}},
    }
    validate_payload("jarvis_message.schema.json", valid)
    with pytest.raises(SchemaValidationError):
        validate_payload("jarvis_message.schema.json", {"channel": "x"})


def test_jarvis_project_schema_valid_invalid() -> None:
    valid = {
        "project_type": "project-dev",
        "title": "Créer un outil",
        "summary": "outil CLI",
        "objective": "Déployer",
        "scope": ["script"],
        "constraints": ["JSON in/out"],
        "inputs": ["compose_path"],
        "outputs": ["status"],
        "tasks": [{"id": "T1", "title": "Squelette", "type": "create_tool"}],
        "tools_needed": ["python"],
        "success_criteria": ["ok"],
        "source": {"channel": "openwebui", "conversation_id": "conv-123"},
    }
    validate_payload("jarvis_project.schema.json", valid)
    bad = dict(valid)
    bad["project_type"] = "x"
    with pytest.raises(SchemaValidationError):
        validate_payload("jarvis_project.schema.json", bad)


def test_tool_manifest_schema_valid_invalid() -> None:
    valid = {
        "name": "example_echo",
        "description": "Retourne message",
        "action_types": ["run_tool"],
        "entrypoint": "tool.py",
        "input_schema": {"type": "object"},
        "output_schema": {"type": "object"},
    }
    validate_payload("tool_manifest.schema.json", valid)
    with pytest.raises(SchemaValidationError):
        validate_payload("tool_manifest.schema.json", {"name": "x"})


def test_tool_output_schema_valid_invalid() -> None:
    valid = {"ok": True, "tool": "example_echo", "message": "done", "data": {"echo": "hello"}}
    validate_payload("tool_output.schema.json", valid)
    with pytest.raises(SchemaValidationError):
        validate_payload("tool_output.schema.json", {"ok": True})


def test_tool_run_request_defaults_input_context() -> None:
    payload = ToolRunRequest(tool="example_echo")
    assert payload.input == {}
    assert payload.context == {}
