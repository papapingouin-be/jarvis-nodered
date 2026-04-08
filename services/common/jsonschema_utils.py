from __future__ import annotations

import json
from pathlib import Path
from typing import Any

try:
    from jsonschema import Draft202012Validator  # type: ignore
except ModuleNotFoundError:  # pragma: no cover
    Draft202012Validator = None

ROOT = Path(__file__).resolve().parents[2]
SCHEMAS_DIR = ROOT / "jarvis" / "schemas"


class SchemaValidationError(ValueError):
    pass


def load_schema(name: str) -> dict[str, Any]:
    schema_path = SCHEMAS_DIR / name
    return json.loads(schema_path.read_text(encoding="utf-8"))


def validate_against_schema(schema: dict[str, Any], payload: dict[str, Any]) -> None:
    if Draft202012Validator is not None:
        errors = sorted(Draft202012Validator(schema).iter_errors(payload), key=lambda e: e.path)
        if errors:
            raise SchemaValidationError("; ".join(err.message for err in errors))
        return

    required = schema.get("required", [])
    for key in required:
        if key not in payload:
            raise SchemaValidationError(f"'{key}' is a required property")
    for key, prop in schema.get("properties", {}).items():
        if key in payload and prop.get("type") == "string" and not isinstance(payload[key], str):
            raise SchemaValidationError(f"'{key}' should be string")
    if "const" in schema.get("properties", {}).get("project_type", {}):
        if payload.get("project_type") != schema["properties"]["project_type"]["const"]:
            raise SchemaValidationError("project_type const mismatch")


def validate_payload(schema_name: str, payload: dict[str, Any]) -> None:
    schema = load_schema(schema_name)
    validate_against_schema(schema, payload)
