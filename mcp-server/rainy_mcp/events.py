"""Live-update channel to the Swift app.

Design note (see ../docs/DECISIONS.md D14 / R1-revised): the MCP stdio stream is owned
by whoever launched the server (Claude Code OR the app's real-time router), so we must NOT
write change events to stdout — that would corrupt the JSON-RPC protocol. Instead we push
newline-delimited JSON events to a Unix domain socket the app hosts, path passed via
RAINY_EVENT_SOCKET. If unset/unreachable, this is a silent no-op (e.g. when Claude Code
launches us and the app simply re-fetches from SQLite on a debounce).
"""
from __future__ import annotations

import json
import os
import socket
import sys
from typing import Any


def emit(event: str, payload: dict[str, Any]) -> None:
    sock_path = os.environ.get("RAINY_EVENT_SOCKET")
    if not sock_path:
        return
    line = json.dumps({"event": event, "payload": payload}) + "\n"
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(0.25)
            s.connect(sock_path)
            s.sendall(line.encode("utf-8"))
    except OSError as exc:  # app not listening — fine, it will re-fetch from SQLite
        print(f"[rainy-mcp] event emit skipped ({event}): {exc}", file=sys.stderr)
