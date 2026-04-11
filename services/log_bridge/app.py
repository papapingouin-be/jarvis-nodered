from __future__ import annotations

import json
import os
from pathlib import Path

from fastapi import FastAPI

from services.common.logging_utils import configure_logging, log_event

app = FastAPI(title="log_bridge", version="1.0")
logger = configure_logging("log_bridge")
LOG_FILE = Path(os.getenv("LOG_BRIDGE_FILE", "/var/log/jarvis/events.jsonl"))


@app.get("/health")
def health() -> dict[str, str]:
    log_event(logger, service="log_bridge", event="healthcheck")
    return {"status": "ok"}


@app.post("/v1/log")
def write_log(payload: dict) -> dict:
    line = json.dumps(payload, ensure_ascii=False)
    print(line)
    log_event(logger, service="log_bridge", event="write_log", source=payload.get("source", "unknown"), kind=payload.get("kind", "unknown"))
    try:
        LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        with LOG_FILE.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass
    return {"ok": True}
