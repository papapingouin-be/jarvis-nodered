import os

from services.toolbox_runner.registry import build_registry
from services.toolbox_runner.runner import run_tool


def test_run_npm_service_flow(tmp_path) -> None:
    os.environ["JARVIS_INFRA_DB"] = str(tmp_path / "infra.db")
    sensitive_manifest = build_registry()["sensitive_store"]
    npm_manifest = build_registry()["npm_service"]

    run_tool(
        sensitive_manifest,
        {
            "operation": "set",
            "namespace": "npm",
            "key": "admin-pass",
            "value": "topsecret",
        },
    )

    run_tool(
        npm_manifest,
        {
            "intent": "registry.register_instance",
            "instance": {
                "name": "npm-home",
                "base_url": "http://npm.local:81",
                "login": "admin@example.local",
                "password_secret_key": "admin-pass",
            },
        },
    )

    run_tool(
        npm_manifest,
        {
            "intent": "registry.register_service",
            "service": {
                "domain": "app.example.local",
                "instance_name": "npm-home",
                "forward_host": "10.0.0.8",
                "forward_port": 1880,
            },
        },
    )

    out_plan = run_tool(
        npm_manifest,
        {
            "intent": "plan.service_action",
            "instance_name": "npm-home",
            "domain": "app.example.local",
            "action": "add",
        },
    )
    assert out_plan["data"]["result"]["request"]["url"].endswith("/api/nginx/proxy-hosts")
    assert out_plan["data"]["result"]["auth"]["password"] == "topsecret"


def test_run_npm_service_uses_operation_when_intent_is_blank(tmp_path) -> None:
    os.environ["JARVIS_INFRA_DB"] = str(tmp_path / "infra.db")
    npm_manifest = build_registry()["npm_service"]

    out = run_tool(
        npm_manifest,
        {
            "intent": "",
            "operation": "describe",
        },
    )
    assert out["data"]["intent"] == "describe"


def test_run_npm_service_uses_mode_when_intent_and_operation_are_blank(tmp_path) -> None:
    os.environ["JARVIS_INFRA_DB"] = str(tmp_path / "infra.db")
    npm_manifest = build_registry()["npm_service"]

    out = run_tool(
        npm_manifest,
        {
            "intent": "",
            "mode": "inspect.describe",
        },
    )
    assert out["data"]["intent"] == "describe"
