from __future__ import annotations

import os

from fastapi import FastAPI

from services.common.jarvis_types import JarvisMessage
from services.llm_adapter.providers.mock import MockProvider
from services.llm_adapter.providers.ollama import OllamaProvider

app = FastAPI(title="llm_adapter", version="1.0")
provider = OllamaProvider() if os.getenv("LLM_PROVIDER", "mock") == "ollama" else MockProvider()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/v1/classify")
def classify(message: JarvisMessage) -> dict:
    return provider.classify(message.model_dump(mode="json"))


@app.post("/v1/project_dev/step")
def project_dev_step(message: JarvisMessage) -> dict:
    return provider.project_step(message.model_dump(mode="json"))


@app.post("/v1/summarize_logs")
def summarize_logs(payload: dict) -> dict:
    return provider.summarize_logs(payload)
