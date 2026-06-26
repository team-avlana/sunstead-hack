"""Websocket connection registry and broadcast helper.

Two ways a change reaches the canvas:
  1. In-process: the artifact MCP tools `await broadcast(...)` directly.
  2. Cross-process: the analysis-worker (a subprocess) and analyze_video emit a
     Postgres NOTIFY on 'rainy_change'; `pg_listen()` (started in the server
     lifespan) forwards those to the right websocket subscribers.
"""

import asyncio
import json
import logging
import random
from typing import Any

from starlette.concurrency import run_in_threadpool
from starlette.websockets import WebSocket, WebSocketDisconnect

import db
import dev_events

log = logging.getLogger("rainy.notify")

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
    """Send a change signal to all relevant subscribers.

    Each send is isolated and bounded by a timeout, fanned out concurrently, so a
    single slow/half-open client cannot stall the other subscribers or the
    pg_listen drain loop. The (ws, bucket) membership is captured under the lock so
    pruning a dead socket targets the right bucket without racing.
    """
    payload = json.dumps(signal)
    async with _connections_lock:
        proj = set(_connections.get(project_id, set()))
        targets: list[tuple[WebSocket, str]] = [(ws, project_id) for ws in proj]
        targets += [(ws, "__all__") for ws in _connections.get("__all__", set()) if ws not in proj]

    if not targets:
        return

    async def _send(ws: WebSocket) -> bool:
        try:
            await asyncio.wait_for(ws.send_text(payload), timeout=5.0)
            return True
        except Exception:
            return False

    results = await asyncio.gather(*[_send(ws) for ws, _ in targets])
    dead = [(ws, key) for (ws, key), ok in zip(targets, results) if not ok]
    if dead:
        async with _connections_lock:
            for ws, key in dead:
                _connections.get(key, set()).discard(ws)


async def websocket_endpoint(ws: WebSocket) -> None:
    # Two subscription scopes share this endpoint:
    #   ?project_id=… → artifact change-signals for a project (the canvas re-pulls).
    #   ?video_id=…   → updates for ONE video (a local Video Block watching its own
    #                   analysis live, without an artifact to scope it). Keyed
    #                   "video:{id}" so a local block gets pushed stage/done signals
    #                   instead of polling GET /api/videos/{id}.
    project_id: str | None = ws.query_params.get("project_id")
    video_id: str | None = ws.query_params.get("video_id")
    key = f"video:{video_id}" if video_id else project_id
    await ws.accept()
    await register(ws, key)
    try:
        while True:
            # Keep connection alive; clients don't send data
            await ws.receive_text()
    except (WebSocketDisconnect, Exception):
        pass
    finally:
        await unregister(ws, key)


# ── Postgres LISTEN/NOTIFY bridge ──────────────────────────────────────────────

async def _route_change(payload: dict[str, Any]) -> None:
    """Forward a 'rainy_change' notification to the right websocket subscribers."""
    kind = payload.get("type")
    if kind == "video":
        video_id = payload.get("video_id")
        action = payload.get("action")
        stage = payload.get("stage")
        # Surface analysis lifecycle on the dev activity bus (no-op when disabled).
        dev_events.emit_event(
            "log", "analysis",
            f"video {action}" + (f": {stage}" if stage else ""), "INFO",
            detail=str(video_id),
        )
        signal = {"type": "video", "action": action, "video_id": video_id}
        if stage:
            signal["stage"] = stage
        # Local Video Blocks subscribe by video_id — push straight to them so they
        # never poll. (Their canvas project may not reference the video as an
        # artifact, so the project routing below wouldn't reach them.)
        if video_id:
            await broadcast(signal, project_id=f"video:{video_id}")
        project_ids = []
        if video_id:
            try:
                project_ids = await run_in_threadpool(db.project_ids_for_video, video_id)
            except Exception:
                project_ids = []
        if project_ids:
            for pid in project_ids:
                await broadcast(signal, project_id=pid)
        elif not video_id:
            # Nothing to scope to — tell any unscoped (all-projects) listeners.
            await broadcast(signal, project_id="__all__")
    elif kind == "artifact":
        pid = payload.get("project_id")
        if pid:
            await broadcast(payload, project_id=pid)


async def pg_listen(dsn: str) -> None:
    """Long-lived task: LISTEN on 'rainy_change' and fan notifications out to WS.
    Reconnects on failure. Started/cancelled by the server lifespan."""
    import psycopg

    delay = 2.0
    while True:
        aconn = None
        try:
            aconn = await psycopg.AsyncConnection.connect(dsn, autocommit=True)
            delay = 2.0  # reset backoff on a successful connect
            await aconn.execute("LISTEN rainy_change")
            async for note in aconn.notifies():
                try:
                    payload = json.loads(note.payload)
                except Exception:
                    continue
                await _route_change(payload)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # Surface the error (a wrong/missing DSN must not be a silent no-op),
            # then retry with capped exponential backoff + jitter.
            log.warning("pg_listen connection error, retrying in %.1fs: %r", delay, exc)
            await asyncio.sleep(delay + random.uniform(0, delay * 0.25))
            delay = min(delay * 2, 30.0)
        finally:
            # Always close — connect() may have opened a TCP connection before
            # raising (e.g. InterfaceError on wrong event-loop type on Windows).
            if aconn is not None:
                try:
                    await aconn.close()
                except Exception:
                    pass
