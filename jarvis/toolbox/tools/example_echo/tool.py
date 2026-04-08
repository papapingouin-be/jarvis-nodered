#!/usr/bin/env python3
from __future__ import annotations

import json
import sys


def main() -> int:
    raw = sys.stdin.read() or "{}"
    payload = json.loads(raw)
    if "message" not in payload:
        print(json.dumps({"error": "missing field: message"}))
        return 1
    print(json.dumps({"echo": payload["message"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
