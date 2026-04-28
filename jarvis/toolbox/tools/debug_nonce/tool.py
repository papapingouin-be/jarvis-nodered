#!/usr/bin/env python3
from __future__ import annotations

import json
import random
import sys
from datetime import datetime, timezone


def main() -> int:
    _ = json.loads(sys.stdin.read() or "{}")
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    rand = f"{random.getrandbits(32):08x}"
    nonce = f"JARVIS-RUNTIME-{ts}-{rand}"
    print(json.dumps({"nonce": nonce, "source": "real_toolbox_runner"}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
