from fastapi.testclient import TestClient

from services.toolbox_runner import app as toolbox_app


def test_openapi_options_preflight_is_allowed() -> None:
    client = TestClient(toolbox_app.app)
    response = client.options(
        "/openapi.json",
        headers={
            "Origin": "http://openwebui.jarvis.papapingouinbe.duckdns.org",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "*"


def test_openapi_get_includes_cors_header() -> None:
    client = TestClient(toolbox_app.app)
    response = client.get(
        "/openapi.json",
        headers={"Origin": "http://openwebui.jarvis.papapingouinbe.duckdns.org"},
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "*"
