import os

from services.toolbox_runner.registry import build_registry
from services.toolbox_runner.runner import run_tool


def test_run_proxmox_ct_flow(tmp_path) -> None:
    os.environ["JARVIS_INFRA_DB"] = str(tmp_path / "infra.db")
    registry = build_registry()
    sensitive_manifest = registry["sensitive_store"]
    manifest = registry["proxmox_ct"]

    run_tool(
        sensitive_manifest,
        {
            "operation": "set",
            "namespace": "proxmox",
            "key": "pve-pass",
            "value": "secret",
        },
    )

    out_target = run_tool(
        manifest,
        {
            "operation": "register_target",
            "target": {
                "name": "pve-home",
                "ip": "10.0.0.2",
                "api_path": "/api2/json",
                "login": "root@pam",
                "password_secret_key": "pve-pass",
                "node": "pve",
            },
        },
    )
    assert out_target["data"]["result"]["saved_target"] == "pve-home"

    out_service = run_tool(
        manifest,
        {
            "operation": "register_service",
            "service": {
                "name": "dns-prod",
                "target_name": "pve-home",
                "ctid": 101,
                "path": "/srv/dns",
            },
        },
    )
    assert out_service["data"]["result"]["saved_service"] == "dns-prod"

    out_plan = run_tool(
        manifest,
        {
            "operation": "plan_ct_action",
            "service_name": "dns-prod",
            "action": "restart",
        },
    )
    assert out_plan["data"]["result"]["request"]["url"].endswith("/nodes/pve/lxc/101/status/reboot")
    assert out_plan["data"]["result"]["request"]["auth"]["password"] == "secret"
