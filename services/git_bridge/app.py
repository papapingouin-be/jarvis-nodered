from __future__ import annotations

from fastapi import FastAPI
from pydantic import BaseModel

from services.common.logging_utils import configure_logging, log_event
from services.git_bridge.git_ops import commit_if_dirty

app = FastAPI(title="git_bridge", version="1.0")
logger = configure_logging("git_bridge")


class CommitRequest(BaseModel):
    repo_path: str
    branch: str
    message: str


@app.get("/health")
def health() -> dict[str, str]:
    log_event(logger, service="git_bridge", event="healthcheck")
    return {"status": "ok"}


@app.post("/v1/commit_if_dirty")
def commit(payload: CommitRequest) -> dict:
    log_event(logger, service="git_bridge", event="commit_if_dirty", repo_path=payload.repo_path, branch=payload.branch)
    return commit_if_dirty(payload.repo_path, payload.branch, payload.message)
