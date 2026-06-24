"""Websocket connection registry and broadcast helper."""

import asyncio
import json
from typing import Any

from starlette.websockets import WebSocket, WebSocketDisconnect

_connections: dict[str, set[WebSocket]] = {}
_connections_lock = asyncio.Lock()


async def register(ws: WebSocket, project_id: str | None = None) -> None:
    key = project_id or "__all__"
    async with _connections_lock:
        _connections.setdefault(key, set()).add(ws)


async def unregister(ws: WebSocket, project_id: str | None = None) -> None:
    key = project_id or "__all__"
    async with _connections_lock:
        bucket = _connections.get(key, set())
        bucket.discard(ws)
        if not bucket:
            _connections.pop(key, None)


async def broadcast(signal: dict[str, Any], project_id: str) -> None:
    """Send a change signal to all relevant subscribers."""
    payload = json.dumps(signal)
    async with _connections_lock:
        targets = (
            set(_connections.get(project_id, set()))
            | set(_connections.get("__all__", set()))
        )

    dead: list[tuple[WebSocket, str | None]] = []
    for ws in targets:
        try:
            await ws.send_text(payload)
        except Exception:
            key = project_id if ws in _connections.get(project_id, set()) else "__all__"
            dead.append((ws, key))

    for ws, key in dead:
        async with _connections_lock:
            _connections.get(key, set()).discard(ws)


async def websocket_endpoint(ws: WebSocket) -> None:
    project_id: str | None = ws.query_params.get("project_id")
    await ws.accept()
    await register(ws, project_id)
    try:
        while True:
            # Keep connection alive; clients don't send data
            await ws.receive_text()
    except (WebSocketDisconnect, Exception):
        pass
    finally:
        await unregister(ws, project_id)
