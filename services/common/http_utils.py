from __future__ import annotations

import httpx


def build_client(timeout_s: float = 30.0) -> httpx.Client:
    return httpx.Client(timeout=timeout_s)
