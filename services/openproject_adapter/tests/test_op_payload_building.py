from services.openproject_adapter.client import build_work_package_payload


def test_work_package_payload_links_and_custom_fields() -> None:
    payload = build_work_package_payload(
        12,
        "Sujet",
        "Desc",
        custom_field_map={"jarvis_status": "customField7"},
        jarvis_fields={"jarvis_status": "ready", "jarvis_tool_needed": ""},
    )
    assert payload["_links"]["project"]["href"] == "/api/v3/projects/12"
    assert payload["customField7"] == "ready"
