import os

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
