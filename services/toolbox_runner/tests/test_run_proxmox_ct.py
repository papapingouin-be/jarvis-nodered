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


def test_run_proxmox_ct_metadata_operations(tmp_path) -> None:
    os.environ["JARVIS_INFRA_DB"] = str(tmp_path / "infra.db")
    registry = build_registry()
    manifest = registry["proxmox_ct"]

    out_registry_doc = run_tool(manifest, {"operation": "registry-doc"})
    services = out_registry_doc["data"]["result"]["services"]
    assert any(service["name"] == "register_target" for service in services)

    out_list_services = run_tool(manifest, {"operation": "list-services"})
    assert "plan_ct_action" in out_list_services["data"]["result"]["services"]
    assert "collect" in out_list_services["data"]["result"]["services"]

    out_describe_service = run_tool(
        manifest,
        {"operation": "describe-service", "meta_service": "plan_ct_action"},
    )
    assert out_describe_service["data"]["result"]["phase"] == "execute"

    out_validate = run_tool(
        manifest,
        {
            "operation": "validate-service-input",
            "meta_service": "plan_ct_action",
            "params": {"service_name": "dns-prod"},
        },
    )
    assert out_validate["data"]["result"]["ready"] is False
    assert "action" in out_validate["data"]["result"]["missing_required"]


def test_run_proxmox_ct_collect_operation(tmp_path) -> None:
    os.environ["JARVIS_INFRA_DB"] = str(tmp_path / "infra.db")
    registry = build_registry()
    manifest = registry["proxmox_ct"]

    out = run_tool(manifest, {"operation": "collect"})
    assert out["data"]["operation"] == "collect"
    assert "collected" in out["data"]["result"]
