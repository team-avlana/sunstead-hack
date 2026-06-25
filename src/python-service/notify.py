"""Websocket connection registry and broadcast helper.

Two ways a change reaches the canvas:
  1. In-process: the artifact MCP tools `await broadcast(...)` directly.
  2. Cross-process: the analysis-worker (a subprocess) and analyze_video emit a
     Postgres NOTIFY on 'rainy_change'; `pg_listen()` (started in the server
     lifespan) forwards those to the right websocket subscribers.
"""

import asyncio
import json
from typing import Any

from starlette.concurrency import run_in_threadpool
from starlette.websockets import WebSocket, WebSocketDisconnect

import db

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


# ── Postgres LISTEN/NOTIFY bridge ──────────────────────────────────────────────

async def _route_change(payload: dict[str, Any]) -> None:
    """Forward a 'rainy_change' notification to the right websocket subscribers."""
    kind = payload.get("type")
    if kind == "video":
        video_id = payload.get("video_id")
        signal = {"type": "video", "action": payload.get("action"), "video_id": video_id}
        project_ids = []
        if video_id:
            try:
                project_ids = await run_in_threadpool(db.project_ids_for_video, video_id)
            except Exception:
                project_ids = []
        if project_ids:
            for pid in project_ids:
                await broadcast(signal, project_id=pid)
        else:
            # Nothing references it yet — tell any unscoped (all-projects) listeners.
            await broadcast(signal, project_id="__all__")
    elif kind == "artifact":
        pid = payload.get("project_id")
        if pid:
            await broadcast(payload, project_id=pid)


async def pg_listen(dsn: str) -> None:
    """Long-lived task: LISTEN on 'rainy_change' and fan notifications out to WS.
    Reconnects on failure. Started/cancelled by the server lifespan."""
    import psycopg

    while True:
        try:
            aconn = await psycopg.AsyncConnection.connect(dsn, autocommit=True)
            try:
                await aconn.execute("LISTEN rainy_change")
                async for note in aconn.notifies():
                    try:
                        payload = json.loads(note.payload)
                    except Exception:
                        continue
                    await _route_change(payload)
            finally:
                await aconn.close()
        except asyncio.CancelledError:
            raise
        except Exception:
            await asyncio.sleep(2.0)  # transient DB / network error — retry
