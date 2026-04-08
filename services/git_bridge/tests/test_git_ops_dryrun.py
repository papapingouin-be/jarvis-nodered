from services.git_bridge.git_ops import commit_if_dirty


def test_commit_if_dirty_dry_run(monkeypatch) -> None:
    monkeypatch.setenv("DRY_RUN", "true")
    out = commit_if_dirty(".", "jarvis/test", "msg")
    assert out["ok"] is True
    assert out["dry_run"] is True
