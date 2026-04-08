from __future__ import annotations

from fastapi import FastAPI
from pydantic import BaseModel

from services.git_bridge.git_ops import commit_if_dirty

app = FastAPI(title="git_bridge", version="1.0")


class CommitRequest(BaseModel):
    repo_path: str
    branch: str
    message: str


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/v1/commit_if_dirty")
def commit(payload: CommitRequest) -> dict:
    return commit_if_dirty(payload.repo_path, payload.branch, payload.message)
