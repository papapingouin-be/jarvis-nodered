from __future__ import annotations

from typing import Any

from services.llm_adapter.providers.base import LLMProvider


class MockProvider(LLMProvider):
    def classify(self, payload: dict[str, Any]) -> dict[str, Any]:
        text = payload.get("text", "").lower()
        if "projet" in text or "outil" in text:
            mode = "project-dev"
        elif "status" in text:
            mode = "status_query"
        elif "run" in text:
            mode = "run_tool"
        else:
            mode = "chat.simple"
        return {"mode": mode, "confidence": 0.82, "summary": "mock", "entities": {}}

    def project_step(self, payload: dict[str, Any]) -> dict[str, Any]:
        text = payload.get("text", "")
        if len(text) < 10:
            return {
                "state": "clarifying",
                "reply_to_user": True,
                "question": "Peux-tu préciser l'objectif du projet ?",
                "done": False,
            }
        return {
            "state": "done",
            "reply_to_user": False,
            "done": True,
            "jarvis_project_json": {
                "project_type": "project-dev",
                "title": "Projet généré en mock",
                "summary": "spec mock",
                "objective": "démontrer le flux",
                "scope": ["script"],
                "constraints": ["JSON in/out"],
                "inputs": ["message"],
                "outputs": ["result"],
                "tasks": [
                    {
                        "id": "T1",
                        "title": "Echo",
                        "type": "run_tool",
                        "tool_needed": "example_echo",
                    }
                ],
                "tools_needed": ["python"],
                "success_criteria": ["flow green"],
                "source": {
                    "channel": payload.get("channel", "openwebui"),
                    "conversation_id": payload.get("conversation_id", "n/a"),
                },
            },
        }

    def summarize_logs(self, payload: dict[str, Any]) -> dict[str, Any]:
        logs = payload.get("logs", [])
        return {"summary": f"{len(logs)} logs traités"}
