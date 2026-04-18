import os
import socket
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

from services.toolbox_runner.registry import build_registry
from services.toolbox_runner.runner import run_tool


class _StatusHandler(BaseHTTPRequestHandler):
    status_code = 200

    def do_GET(self):  # noqa: N802
        self.send_response(self.status_code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, format, *args):  # noqa: A003
        return


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _start_server(status_code: int) -> tuple[HTTPServer, threading.Thread, str]:
    port = _free_port()

    class _Handler(_StatusHandler):
        pass

    _Handler.status_code = status_code
    server = HTTPServer(("127.0.0.1", port), _Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread, f"http://127.0.0.1:{port}/health"


def test_run_http_probe_flow(tmp_path) -> None:
    os.environ["JARVIS_INFRA_DB"] = str(tmp_path / "infra.db")
    manifest = build_registry()["http_probe"]

    server, thread, url = _start_server(200)
    try:
        out_register = run_tool(
            manifest,
            {
                "intent": "registry.register_endpoint",
                "name": "jarvis-home",
                "url": url,
                "expected_status": 200,
                "timeout_s": 3,
            },
        )
        assert out_register["ok"] is True
        assert out_register["data"]["intent"] == "register_endpoint"

        out_list = run_tool(
            manifest,
            {
                "intent": "list.endpoints",
            },
        )
        assert out_list["data"]["result"]["count"] == 1
        assert out_list["data"]["result"]["endpoints"][0]["name"] == "jarvis-home"

        out_check = run_tool(
            manifest,
            {
                "intent": "check.endpoint",
                "name": "jarvis-home",
            },
        )
        assert out_check["data"]["result"]["probe"]["ok"] is True
        assert out_check["data"]["result"]["probe"]["status"] == 200
    finally:
        server.shutdown()
        thread.join(timeout=2)


def test_run_http_probe_uses_operation_when_intent_is_blank(tmp_path) -> None:
    os.environ["JARVIS_INFRA_DB"] = str(tmp_path / "infra.db")
    manifest = build_registry()["http_probe"]

    out = run_tool(
        manifest,
        {
            "intent": "",
            "operation": "describe",
        },
    )
    assert out["data"]["intent"] == "describe"


def test_run_http_probe_failed_check_returns_result_not_crash(tmp_path) -> None:
    os.environ["JARVIS_INFRA_DB"] = str(tmp_path / "infra.db")
    manifest = build_registry()["http_probe"]

    server, thread, url = _start_server(503)
    try:
        run_tool(
            manifest,
            {
                "intent": "registry.register_endpoint",
                "name": "jarvis-home",
                "url": url,
                "expected_status": 200,
            },
        )

        out = run_tool(
            manifest,
            {
                "intent": "check.endpoint",
                "name": "jarvis-home",
            },
        )
        probe = out["data"]["result"]["probe"]
        assert probe["ok"] is False
        assert probe["status"] == 503
        assert probe["error"] == "Service Unavailable"
    finally:
        server.shutdown()
        thread.join(timeout=2)
