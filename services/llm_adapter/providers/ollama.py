from __future__ import annotations

import os
from typing import Any

import httpx

from services.llm_adapter.providers.base import LLMProvider


class OllamaProvider(LLMProvider):
    def __init__(self) -> None:
        self.base_url = os.getenv("OLLAMA_BASE_URL", "http://ollama:11434")

    def _chat_json(self, model: str, prompt: str) -> dict[str, Any]:
        response = httpx.post(
            f"{self.base_url}/api/chat",
            json={
                "model": model,
                "stream": False,
                "format": "json",
                "messages": [{"role": "user", "content": prompt}],
            },
            timeout=60,
        )
        response.raise_for_status()
        content = response.json().get("message", {}).get("content", "{}")
        return httpx.Response(200, text=content).json()

    def classify(self, payload: dict[str, Any]) -> dict[str, Any]:
        model = os.getenv("LLM_MODEL_CLASSIFY", "llama3.1:8b")
        prompt = (
            "Classify message and return JSON with mode/confidence/summary/entities: "
            f"{payload}"
        )
        return self._chat_json(model, prompt)

    def project_step(self, payload: dict[str, Any]) -> dict[str, Any]:
        model = os.getenv("LLM_MODEL_PROJECT", "llama3.1:8b")
        prompt = f"Project-dev step JSON only: {payload}"
        return self._chat_json(model, prompt)

    def summarize_logs(self, payload: dict[str, Any]) -> dict[str, Any]:
        model = os.getenv("LLM_MODEL_SUMMARY", "llama3.1:8b")
        prompt = f"Summarize logs in JSON with key summary: {payload}"
        return self._chat_json(model, prompt)
