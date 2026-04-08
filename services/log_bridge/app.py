from __future__ import annotations

import json
import os
from pathlib import Path

from fastapi import FastAPI

app = FastAPI(title="log_bridge", version="1.0")
LOG_FILE = Path(os.getenv("LOG_BRIDGE_FILE", "/var/log/jarvis/events.jsonl"))


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/v1/log")
def write_log(payload: dict) -> dict:
    line = json.dumps(payload, ensure_ascii=False)
    print(line)
    try:
        LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        with LOG_FILE.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass
    return {"ok": True}
