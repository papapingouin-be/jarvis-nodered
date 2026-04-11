from __future__ import annotations

import os

from fastapi import FastAPI

from services.common.logging_utils import configure_logging, log_event
from services.common.jarvis_types import JarvisMessage
from services.llm_adapter.providers.mock import MockProvider
from services.llm_adapter.providers.ollama import OllamaProvider

app = FastAPI(title="llm_adapter", version="1.0")
logger = configure_logging("llm_adapter")
provider = OllamaProvider() if os.getenv("LLM_PROVIDER", "mock") == "ollama" else MockProvider()


@app.get("/health")
def health() -> dict[str, str]:
    log_event(logger, service="llm_adapter", event="healthcheck")
    return {"status": "ok"}


@app.post("/v1/classify")
def classify(message: JarvisMessage) -> dict:
    log_event(logger, service="llm_adapter", event="classify", conversation_id=message.conversation_id, message_id=message.message_id)
    return provider.classify(message.model_dump(mode="json"))


@app.post("/v1/project_dev/step")
def project_dev_step(message: JarvisMessage) -> dict:
    log_event(logger, service="llm_adapter", event="project_dev_step", conversation_id=message.conversation_id, message_id=message.message_id)
    return provider.project_step(message.model_dump(mode="json"))


@app.post("/v1/summarize_logs")
def summarize_logs(payload: dict) -> dict:
    log_event(logger, service="llm_adapter", event="summarize_logs", keys=sorted(payload.keys()))
    return provider.summarize_logs(payload)
