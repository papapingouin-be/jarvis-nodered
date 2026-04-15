import os
from unittest.mock import patch

from jarvis.toolbox.tools.proxmox_ct import tool as proxmox_tool
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
            "intent": "registry.register_target",
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
            "intent": "registry.register_service",
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
            "intent": "plan.ct_action",
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

    out_registry_doc = run_tool(manifest, {"intent": "registry.doc"})
    services = out_registry_doc["data"]["result"]["services"]
    assert any(service["name"] == "register_target" for service in services)

    out_list_services = run_tool(manifest, {"intent": "list-services"})
    assert "plan_ct_action" in out_list_services["data"]["result"]["services"]
    assert "collect" in out_list_services["data"]["result"]["services"]

    out_describe_service = run_tool(
        manifest,
        {"intent": "describe-service", "meta_service": "plan_ct_action"},
    )
    assert out_describe_service["data"]["result"]["phase"] == "execute"

    out_validate = run_tool(
        manifest,
        {
            "intent": "validate-service-input",
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

    out = run_tool(manifest, {"intent": "list.infrastructure"})
    assert out["data"]["intent"] == "collect"
    assert "collected" in out["data"]["result"]
    assert "containers" in out["data"]["result"]


def test_run_proxmox_ct_list_ct_alias(tmp_path) -> None:
    os.environ["JARVIS_INFRA_DB"] = str(tmp_path / "infra.db")
    registry = build_registry()
    manifest = registry["proxmox_ct"]

    out = run_tool(manifest, {"intent": "list.containers"})
    assert out["data"]["intent"] == "list_ct"
    assert "collected" in out["data"]["result"]
    assert list(out["data"]["result"]["collected"].keys()) == ["containers"]
    assert "containers" in out["data"]["result"]


def test_run_proxmox_ct_list_ct_hyphen_alias(tmp_path) -> None:
    os.environ["JARVIS_INFRA_DB"] = str(tmp_path / "infra.db")
    registry = build_registry()
    manifest = registry["proxmox_ct"]

    out = run_tool(manifest, {"intent": "list-ct"})
    assert out["data"]["intent"] == "list_ct"
    assert list(out["data"]["result"]["collected"].keys()) == ["containers"]


def test_run_proxmox_ct_list_ct_french_alias(tmp_path) -> None:
    os.environ["JARVIS_INFRA_DB"] = str(tmp_path / "infra.db")
    registry = build_registry()
    manifest = registry["proxmox_ct"]

    out = run_tool(manifest, {"intent": "liste"})
    assert out["data"]["intent"] == "list_ct"
    assert list(out["data"]["result"]["collected"].keys()) == ["containers"]


def test_run_proxmox_ct_list_ct_noisy_alias(tmp_path) -> None:
    os.environ["JARVIS_INFRA_DB"] = str(tmp_path / "infra.db")
    registry = build_registry()
    manifest = registry["proxmox_ct"]

    out = run_tool(manifest, {"intent": "list_ctlistelister les ct de proxmodlister les ct de proxmox"})
    assert out["data"]["intent"] == "list_ct"
    assert list(out["data"]["result"]["collected"].keys()) == ["containers"]


def test_run_proxmox_ct_operation_used_when_intent_is_blank(tmp_path) -> None:
    os.environ["JARVIS_INFRA_DB"] = str(tmp_path / "infra.db")
    registry = build_registry()
    manifest = registry["proxmox_ct"]

    out = run_tool(manifest, {"intent": "", "operation": "liste des ct sur proxmox"})
    assert out["data"]["intent"] == "list_ct"
    assert list(out["data"]["result"]["collected"].keys()) == ["containers"]


def test_run_proxmox_ct_uses_env_defaults_for_ssh_target(tmp_path) -> None:
    os.environ["JARVIS_INFRA_DB"] = str(tmp_path / "infra.db")
    os.environ["PROXMOX_HOST"] = "192.168.11.248"
    os.environ["PROXMOX_USER"] = "root"
    registry = build_registry()
    manifest = registry["proxmox_ct"]

    out = run_tool(manifest, {"intent": "list.containers", "ssh_target": ""})
    assert out["data"]["result"]["ssh_target"] == "root@192.168.11.248"


def test_run_proxmox_ct_ssh_command_uses_accept_new_host_key_checking(tmp_path) -> None:
    os.environ["JARVIS_INFRA_DB"] = str(tmp_path / "infra.db")
    os.environ["PROXMOX_HOST"] = "192.168.11.248"
    os.environ["PROXMOX_USER"] = "root"
    registry = build_registry()
    manifest = registry["proxmox_ct"]

    out = run_tool(manifest, {"intent": "list.containers"})
    cmd = out["data"]["result"]["collected"]["containers"]["command"]
    assert "StrictHostKeyChecking=accept-new" in cmd
    assert "--" not in cmd


def test_run_proxmox_ct_list_ct_includes_debug_context_when_requested(tmp_path) -> None:
    os.environ["JARVIS_INFRA_DB"] = str(tmp_path / "infra.db")
    os.environ["PROXMOX_HOST"] = "192.168.11.248"
    os.environ["PROXMOX_USER"] = "root"
    registry = build_registry()
    manifest = registry["proxmox_ct"]

    out = run_tool(manifest, {"intent": "list.containers", "debug": True})
    debug = out["data"]["result"]["debug"]
    assert debug["ssh_target_resolved"] == "root@192.168.11.248"
    assert "StrictHostKeyChecking=accept-new" in debug["ssh_options_key_auth"]


def test_run_proxmox_ct_command_attempts_are_exposed(tmp_path) -> None:
    os.environ["JARVIS_INFRA_DB"] = str(tmp_path / "infra.db")
    os.environ["PROXMOX_HOST"] = "192.168.11.248"
    os.environ["PROXMOX_USER"] = "root"
    registry = build_registry()
    manifest = registry["proxmox_ct"]

    out = run_tool(manifest, {"intent": "list.containers"})
    containers_probe = out["data"]["result"]["collected"]["containers"]
    assert isinstance(containers_probe["attempts"], list)
    assert len(containers_probe["attempts"]) >= 1




def test_parse_pct_list_supports_empty_lock_column() -> None:
    stdout = """VMID       Status     Lock         Name                
100        stopped                 dev                 
101        running    snapshot     ctdev"""

    parsed = proxmox_tool._parse_pct_list(stdout)

    assert parsed == [
        {"ctid": 100, "status": "stopped", "lock": "", "name": "dev", "raw": "100        stopped                 dev"},
        {"ctid": 101, "status": "running", "lock": "snapshot", "name": "ctdev", "raw": "101        running    snapshot     ctdev"},
    ]

def test_run_proxmox_ct_redacts_password_in_debug_commands(tmp_path) -> None:
    os.environ["PROXMOX_PASSWORD"] = "super-secret"
    os.environ["PROXMOX_SSH_PORT"] = "22"
    fake_result = proxmox_tool.subprocess.CompletedProcess(
        args=["dummy"],
        returncode=255,
        stdout="",
        stderr="Permission denied",
    )

    with patch("jarvis.toolbox.tools.proxmox_ct.tool.shutil.which", return_value="/usr/bin/sshpass"), patch.object(
        proxmox_tool.subprocess,
        "run",
        return_value=fake_result,
    ):
        result = proxmox_tool._run_cmd(["bash", "-lc", "pct list"], ssh_target="jarvis@192.168.11.248")

    assert "super-secret" not in " ".join(result["command"])
    assert "22" in result["command"]
    for attempt in result["attempts"]:
        assert "super-secret" not in " ".join(attempt["command"])
        assert "22" in attempt["command"]


def test_run_proxmox_ct_uses_root_password_env_when_available(tmp_path) -> None:
    os.environ["PROXMOX_ROOT_PASSWORD"] = "root-secret"
    os.environ["PROXMOX_PASSWORD"] = "legacy-secret"
    fake_result = proxmox_tool.subprocess.CompletedProcess(
        args=["dummy"],
        returncode=255,
        stdout="",
        stderr="Permission denied",
    )

    with patch("jarvis.toolbox.tools.proxmox_ct.tool.shutil.which", return_value="/usr/bin/sshpass"), patch.object(
        proxmox_tool.subprocess,
        "run",
        return_value=fake_result,
    ):
        result = proxmox_tool._run_cmd(["bash", "-lc", "pct list"], ssh_target="root@192.168.11.248")

    serialized_commands = " ".join(result["command"]) + " " + " ".join(" ".join(a["command"]) for a in result["attempts"])
    assert "legacy-secret" not in serialized_commands
    assert "root-secret" not in serialized_commands


def test_run_proxmox_ct_adds_hint_for_pct_no_command_error(tmp_path) -> None:
    usage_error = "ERROR: no command specified\nUSAGE: pct <COMMAND>"
    fake_result = proxmox_tool.subprocess.CompletedProcess(
        args=["dummy"],
        returncode=255,
        stdout="",
        stderr=usage_error,
    )
    with patch.object(proxmox_tool.subprocess, "run", return_value=fake_result):
        result = proxmox_tool._run_cmd(["bash", "-lc", "pct list"], ssh_target="jarvis@192.168.11.248")
    assert "ForceCommand" in result["stderr"]


def test_run_proxmox_ct_retries_simple_remote_command_without_bash_wrapper(tmp_path) -> None:
    first = proxmox_tool.subprocess.CompletedProcess(
        args=["dummy"],
        returncode=255,
        stdout="",
        stderr="ERROR: no command specified\nUSAGE: pct <COMMAND>",
    )
    second = proxmox_tool.subprocess.CompletedProcess(
        args=["dummy"],
        returncode=0,
        stdout="VMID       Status     Lock         Name\n101        running                 dns-prod",
        stderr="",
    )
    with patch.object(proxmox_tool.subprocess, "run", side_effect=[first, second]):
        result = proxmox_tool._run_cmd(["bash", "-lc", "pct list"], ssh_target="root@192.168.11.248")

    assert result["ok"] is True
    assert result["auth_method"].endswith("_simplified")
    assert any("bash" in attempt["command"] for attempt in result["attempts"])
    assert any(attempt["command"][-2:] == ["pct", "list"] for attempt in result["attempts"])
