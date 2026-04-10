from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


class JarvisMessage(BaseModel):
    channel: str = Field(default="openwebui")
    user_id: str
    conversation_id: str
    message_id: str
    text: str
    attachments: list[dict[str, Any]] = Field(default_factory=list)
    timestamp: datetime
    reply_policy: Literal["same_channel", "async"] = "same_channel"
    meta: dict[str, Any] = Field(default_factory=dict)


class ToolRunRequest(BaseModel):
    tool: str
    input: dict[str, Any] = Field(default_factory=dict)
    context: dict[str, Any] = Field(default_factory=dict)


class ToolOutput(BaseModel):
    ok: bool
    tool: str
    action: str | None = None
    message: str
    data: dict[str, Any] = Field(default_factory=dict)
    artifacts: list[dict[str, Any]] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    logs: list[dict[str, Any]] = Field(default_factory=list)
    error_code: str | None = None
    retryable: bool | None = None
