from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any


def configure_logging(name: str) -> logging.Logger:
    logger = logging.getLogger(name)
    if logger.handlers:
        return logger
    handler = logging.StreamHandler()
    formatter = logging.Formatter("%(message)s")
    handler.setFormatter(formatter)
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    return logger


def to_json_log(payload: dict) -> str:
    return json.dumps(payload, ensure_ascii=False)


def log_event(logger: logging.Logger, service: str, event: str, **fields: Any) -> None:
    payload = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "service": service,
        "event": event,
        **fields,
    }
    logger.info(to_json_log(payload))
