from __future__ import annotations

import re
from typing import Any


def slugify_identifier(title: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", title.lower()).strip("-")
    return slug[:30] or "jarvis-project"


def build_project_payload(title: str, description: str) -> dict[str, Any]:
    return {
        "name": title,
        "identifier": slugify_identifier(title),
        "description": {"format": "markdown", "raw": description},
    }


def build_work_package_payload(
    project_id: int,
    subject: str,
    description_md: str,
    custom_field_map: dict[str, str],
    jarvis_fields: dict[str, str],
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "subject": subject,
        "description": {"format": "markdown", "raw": description_md},
        "_links": {"project": {"href": f"/api/v3/projects/{project_id}"}},
    }
    for key, value in jarvis_fields.items():
        cf_key = custom_field_map.get(key)
        if cf_key and value:
            payload[cf_key] = value
    return payload
