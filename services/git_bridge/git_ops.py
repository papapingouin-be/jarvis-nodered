from __future__ import annotations

import os
import subprocess
from pathlib import Path


def commit_if_dirty(repo_path: str, branch: str, message: str) -> dict:
    dry_run = os.getenv("DRY_RUN", "true").lower() == "true"
    repo = Path(repo_path)
    if dry_run:
        return {"ok": True, "dry_run": True, "branch": branch, "message": message}

    subprocess.run(["git", "checkout", "-B", branch], cwd=repo, check=True)
    status = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=repo,
        check=True,
        text=True,
        capture_output=True,
    )
    if not status.stdout.strip():
        return {"ok": True, "changed": False}
    subprocess.run(["git", "add", "-A"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", message], cwd=repo, check=True)

    remote = os.getenv("GITEA_REMOTE_URL", "")
    if remote:
        subprocess.run(["git", "remote", "add", "jarvis-gitea", remote], cwd=repo, check=False)
        subprocess.run(["git", "push", "-u", "jarvis-gitea", branch], cwd=repo, check=True)
    return {"ok": True, "changed": True}
