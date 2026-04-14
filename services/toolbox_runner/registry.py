from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from services.common.jsonschema_utils import validate_payload
from services.common.logging_utils import configure_logging, log_event

ROOT = Path(__file__).resolve().parents[2]
TOOLS_DIR = ROOT / "jarvis" / "toolbox" / "tools"
REGISTRY_FILE = ROOT / "jarvis" / "toolbox" / "registry" / "tools.registry.json"
logger = configure_logging("toolbox_runner.registry")


def build_registry() -> dict[str, dict[str, Any]]:
    registry: dict[str, dict[str, Any]] = {}
    log_event(logger, service="toolbox_runner", event="registry_scan_start", tools_dir=str(TOOLS_DIR), registry_file=str(REGISTRY_FILE))
    tool_dirs = sorted([path for path in TOOLS_DIR.glob("*") if path.is_dir()])
    log_event(logger, service="toolbox_runner", event="registry_scan_dirs", count=len(tool_dirs), directories=[path.name for path in tool_dirs])
    manifest_paths = sorted(TOOLS_DIR.glob("**/manifest.json"))
    log_event(logger, service="toolbox_runner", event="registry_scan_manifests", count=len(manifest_paths), manifests=[str(path) for path in manifest_paths])
    for manifest_path in manifest_paths:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        validate_payload("tool_manifest.schema.json", manifest)
        tool_root = manifest_path.parent
        manifest["tool_root"] = str(tool_root)
        entrypoint = tool_root / manifest["entrypoint"]
        log_event(
            logger,
            service="toolbox_runner",
            event="registry_manifest_loaded",
            tool=manifest["name"],
            tool_root=str(tool_root),
            entrypoint=str(entrypoint),
            entrypoint_exists=entrypoint.exists(),
            entrypoint_suffix=entrypoint.suffix,
        )
        registry[manifest["name"]] = manifest

    if not registry and REGISTRY_FILE.exists():
        log_event(logger, service="toolbox_runner", event="registry_use_cache", registry_file=str(REGISTRY_FILE))
        return json.loads(REGISTRY_FILE.read_text(encoding="utf-8"))

    REGISTRY_FILE.parent.mkdir(parents=True, exist_ok=True)
    REGISTRY_FILE.write_text(json.dumps(registry, indent=2, ensure_ascii=False), encoding="utf-8")
    log_event(logger, service="toolbox_runner", event="registry_scan_done", tools=sorted(registry.keys()), count=len(registry))
    return registry
