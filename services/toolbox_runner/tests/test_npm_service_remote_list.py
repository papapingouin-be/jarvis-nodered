import os
from urllib import error

from jarvis.toolbox.tools.npm_service import tool as npm_tool


def test_list_services_includes_remote_when_instance_exists(tmp_path, monkeypatch) -> None:
    os.environ["JARVIS_INFRA_DB"] = str(tmp_path / "infra.db")

    def fake_remote(base_url: str, login: str, password: str):
        assert base_url == "http://npm.local:81"
        assert login == "admin@example.local"
        assert password == "topsecret"
        return [{"id": 1, "domain": "app.example.local"}]

    monkeypatch.setattr(npm_tool, "_fetch_remote_services", fake_remote)

    with npm_tool._connect() as conn:
        npm_tool._register_instance(
            conn,
            {
                "instance": {
                    "name": "default",
                    "base_url": "http://npm.local:81",
                    "login": "admin@example.local",
                    "password": "topsecret",
                }
            },
        )

        output = npm_tool._list_services(conn, {"instance_name": "default"})

    assert output["instance_name"] == "default"
    assert output["services"] == []
    assert output["remote_count"] == 1
    assert output["instance_configured"] is True
    assert output["instance_source"] == "registered_instance"
    assert output["remote_services"][0]["domain"] == "app.example.local"


def test_list_services_uses_config_web_sensitive_values_as_fallback(tmp_path, monkeypatch) -> None:
    os.environ["JARVIS_INFRA_DB"] = str(tmp_path / "infra.db")

    def fake_remote(base_url: str, login: str, password: str):
        assert base_url == "http://npm.local:81/api"
        assert login == "admin@example.local"
        assert password == "topsecret"
        return [{"id": 27, "domain": "remote.example.local"}]

    monkeypatch.setattr(npm_tool, "_fetch_remote_services", fake_remote)

    with npm_tool._connect() as conn:
        conn.execute(
            """
            INSERT INTO sensitive_values(namespace, key, value)
            VALUES
              ('npm_service', 'NPM_URL', 'http://npm.local:81/api'),
              ('npm_service', 'NPM_IDENTITY', 'admin@example.local'),
              ('npm_service', 'NPM_SECRET', 'topsecret')
            """
        )
        conn.commit()
        output = npm_tool._list_services(conn, {"instance_name": "default"})

    assert output["instance_name"] == "default"
    assert output["remote_count"] == 1
    assert output["instance_configured"] is True
    assert output["instance_source"] == "config_web_fallback"
    assert output["remote_services"][0]["id"] == 27




def test_list_services_uses_legacy_npm_namespace_fallback(tmp_path, monkeypatch) -> None:
    os.environ["JARVIS_INFRA_DB"] = str(tmp_path / "infra.db")

    def fake_remote(base_url: str, login: str, password: str):
        assert base_url == "http://npm.legacy:81/api"
        assert login == "legacy-admin@example.local"
        assert password == "legacysecret"
        return [{"id": 42, "domain": "legacy.example.local"}]

    monkeypatch.setattr(npm_tool, "_fetch_remote_services", fake_remote)

    with npm_tool._connect() as conn:
        conn.execute(
            """
            INSERT INTO sensitive_values(namespace, key, value)
            VALUES
              ('npm', 'NPM_URL', 'http://npm.legacy:81/api'),
              ('npm', 'NPM_IDENTITY', 'legacy-admin@example.local'),
              ('npm', 'NPM_SECRET', 'legacysecret')
            """
        )
        conn.commit()
        output = npm_tool._list_services(conn, {"instance_name": "default"})

    assert output["instance_name"] == "default"
    assert output["remote_count"] == 1
    assert output["instance_configured"] is True
    assert output["instance_source"] == "config_web_fallback"
    assert output["remote_services"][0]["id"] == 42


def test_list_services_uses_environment_fallback_values(tmp_path, monkeypatch) -> None:
    os.environ["JARVIS_INFRA_DB"] = str(tmp_path / "infra.db")
    os.environ["NPM_URL"] = "http://npm.env:81"
    os.environ["NPM_IDENTITY"] = "env-admin@example.local"
    os.environ["NPM_SECRET"] = "envsecret"

    def fake_remote(base_url: str, login: str, password: str):
        assert base_url == "http://npm.env:81"
        assert login == "env-admin@example.local"
        assert password == "envsecret"
        return [{"id": 99, "domain": "env.example.local"}]

    monkeypatch.setattr(npm_tool, "_fetch_remote_services", fake_remote)

    try:
        with npm_tool._connect() as conn:
            output = npm_tool._list_services(conn, {"instance_name": "default"})
    finally:
        os.environ.pop("NPM_URL", None)
        os.environ.pop("NPM_IDENTITY", None)
        os.environ.pop("NPM_SECRET", None)

    assert output["instance_name"] == "default"
    assert output["remote_count"] == 1
    assert output["instance_configured"] is True
    assert output["instance_source"] == "config_web_fallback"
    assert output["remote_services"][0]["id"] == 99


def test_list_services_without_instance_returns_empty_remote_list(tmp_path) -> None:
    os.environ["JARVIS_INFRA_DB"] = str(tmp_path / "infra.db")

    with npm_tool._connect() as conn:
        output = npm_tool._list_services(conn, {"instance_name": "default"})

    assert output["instance_name"] == "default"
    assert output["services"] == []
    assert output["remote_services"] == []
    assert output["remote_count"] == 0
    assert output["instance_configured"] is False
    assert output["instance_source"] is None
    assert output["required_fallback_namespace"] == "npm_service"
    assert output["accepted_fallback_namespaces"] == ["npm_service", "npm"]
    assert output["required_fallback_keys"] == ["NPM_URL", "NPM_IDENTITY", "NPM_SECRET"]
    assert output["missing_fallback_keys"] == ["NPM_URL", "NPM_IDENTITY", "NPM_SECRET"]
    assert "No NPM instance credentials found" in output["message"]


def test_list_services_without_instance_reports_only_missing_fallback_keys(tmp_path) -> None:
    os.environ["JARVIS_INFRA_DB"] = str(tmp_path / "infra.db")

    with npm_tool._connect() as conn:
        conn.execute(
            """
            INSERT INTO sensitive_values(namespace, key, value)
            VALUES
              ('npm_service', 'NPM_URL', 'http://npm.local:81/api'),
              ('npm_service', 'NPM_IDENTITY', 'admin@example.local')
            """
        )
        conn.commit()
        output = npm_tool._list_services(conn, {"instance_name": "default"})

    assert output["instance_configured"] is False
    assert output["missing_fallback_keys"] == ["NPM_SECRET"]


def test_fetch_remote_services_accepts_base_url_with_api_suffix(monkeypatch) -> None:
    calls: list[tuple[str, str]] = []

    class _Resp:
        def __init__(self, payload: str) -> None:
            self._payload = payload.encode("utf-8")

        def read(self) -> bytes:
            return self._payload

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

    def fake_urlopen(req, timeout=10):  # noqa: ANN001
        calls.append((req.get_method(), req.full_url))
        if req.full_url.endswith("/api/tokens"):
            return _Resp('{"token":"abc"}')
        if req.full_url.endswith("/api/nginx/proxy-hosts"):
            return _Resp('[{"id":1,"domain_names":["app.local"],"forward_host":"app","forward_port":8080,"forward_scheme":"http","enabled":true}]')
        raise AssertionError(f"unexpected URL: {req.full_url}")

    monkeypatch.setattr(npm_tool.request, "urlopen", fake_urlopen)

    result = npm_tool._fetch_remote_services("http://npm.local:81/api", "admin", "secret")

    assert calls == [
        ("POST", "http://npm.local:81/api/tokens"),
        ("GET", "http://npm.local:81/api/nginx/proxy-hosts"),
    ]
    assert result[0]["domain"] == "app.local"


def test_fetch_remote_services_http_error_contains_status_and_url(monkeypatch) -> None:
    def fake_urlopen(req, timeout=10):  # noqa: ANN001
        raise error.HTTPError(
            req.full_url,
            401,
            "Unauthorized",
            hdrs=None,
            fp=None,
        )

    monkeypatch.setattr(npm_tool.request, "urlopen", fake_urlopen)

    try:
        npm_tool._fetch_remote_services("http://npm.local:81", "admin", "bad-secret")
    except ValueError as exc:
        msg = str(exc)
    else:
        raise AssertionError("expected ValueError")

    assert "status=401" in msg
    assert "http://npm.local:81/api/tokens" in msg
