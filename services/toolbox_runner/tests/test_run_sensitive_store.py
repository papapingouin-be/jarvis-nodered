import os

from services.toolbox_runner.registry import build_registry
from services.toolbox_runner.runner import run_tool


def test_run_sensitive_store_flow(tmp_path) -> None:
    os.environ["JARVIS_INFRA_DB"] = str(tmp_path / "infra.db")
    manifest = build_registry()["sensitive_store"]

    out_set = run_tool(
        manifest,
        {
            "operation": "set",
            "namespace": "proxmox",
            "key": "pve-pass",
            "value": "secret",
        },
    )
    assert out_set["data"]["result"]["saved"] is True

    out_get = run_tool(
        manifest,
        {
            "operation": "get",
            "namespace": "proxmox",
            "key": "pve-pass",
        },
    )
    assert out_get["data"]["result"]["value"] == "secret"
