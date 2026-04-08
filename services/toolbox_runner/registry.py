from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from services.common.jsonschema_utils import validate_payload

ROOT = Path(__file__).resolve().parents[2]
TOOLS_DIR = ROOT / "jarvis" / "toolbox" / "tools"
REGISTRY_FILE = ROOT / "jarvis" / "toolbox" / "registry" / "tools.registry.json"


def build_registry() -> dict[str, dict[str, Any]]:
    registry: dict[str, dict[str, Any]] = {}
    for manifest_path in TOOLS_DIR.glob("*/manifest.json"):
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        validate_payload("tool_manifest.schema.json", manifest)
        tool_root = manifest_path.parent
        manifest["tool_root"] = str(tool_root)
        registry[manifest["name"]] = manifest
    REGISTRY_FILE.parent.mkdir(parents=True, exist_ok=True)
    REGISTRY_FILE.write_text(json.dumps(registry, indent=2, ensure_ascii=False), encoding="utf-8")
    return registry
