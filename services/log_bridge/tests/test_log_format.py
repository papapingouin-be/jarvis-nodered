import json


def test_log_payload_serializable() -> None:
    payload = {
        "timestamp": "2026-04-08T12:00:00Z",
        "project_id": "P1",
        "task_id": "T1",
        "module": "toolbox_runner",
        "status": "ok",
    }
    line = json.dumps(payload)
    assert "project_id" in line
