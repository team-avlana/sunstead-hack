"""Dev-only activity / timing event bus (env-gated by RAINY_DEV_LOGS).

A lightweight observability surface for development: it keeps a bounded in-memory
ring buffer of recent events and fans new ones out to live websocket subscribers,
so the canvas-ui can render a "Service Activity" panel showing what the service is
doing and how long each operation takes.

When DISABLED (the default — `RAINY_DEV_LOGS` unset/false) every entry point is a
cheap no-op, the websocket refuses the handshake, and the snapshot endpoint reports
`enabled: false`. Nothing about the service internals is exposed in a normal run.

Event kinds:
  - "span": a timed operation, emitted as a paired start + end (status ok|error)
    sharing a `span_id`; the end carries `duration_ms`.
  - "log":  a forwarded stdlib logging record (level name in `status`).

Thread-safety: events are emitted from the asyncio loop (middleware, pg_listen),
from worker threads (run_in_threadpool), and possibly before the loop exists. We
record the loop at startup (`set_loop`) and deliver via `call_soon_threadsafe`, so
emits from any thread land on the loop without racing the asyncio subscriber queues.
"""

from __future__ import annotations

import asyncio
import contextlib
import itertools
import logging
import time
from collections import deque
from typing import Any, Optional

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.websockets import WebSocket

from config import settings

ENABLED: bool = settings.dev.logs

_RING_MAX = 1000
_ring: "deque[dict]" = deque(maxlen=_RING_MAX)
_subscribers: "set[asyncio.Queue]" = set()
_ids = itertools.count(1)
_span_ids = itertools.count(1)
_loop: Optional[asyncio.AbstractEventLoop] = None


def set_loop(loop: asyncio.AbstractEventLoop) -> None:
    """Record the server's event loop so events emitted from worker threads can be
    delivered to the (asyncio) subscriber queues safely. Called once at startup."""
    global _loop
    _loop = loop


def new_span_id() -> int:
    return next(_span_ids) if ENABLED else 0


def _deliver(event: dict) -> None:
    """Loop-thread only: append to the ring and push to each live subscriber."""
    _ring.append(event)
    for q in list(_subscribers):
        try:
            q.put_nowait(event)
        except asyncio.QueueFull:
            pass  # a slow client drops events rather than stalling the emitter


def _emit(event: dict) -> None:
    loop = _loop
    if loop is None:
        _ring.append(event)  # pre-startup: at least keep it for the backlog replay
        return
    try:
        loop.call_soon_threadsafe(_deliver, event)
    except RuntimeError:
        _ring.append(event)


def emit_event(
    kind: str,
    category: str,
    name: str,
    status: str,
    duration_ms: float | None = None,
    detail: str | None = None,
    span_id: int | None = None,
) -> None:
    if not ENABLED:
        return
    _emit(
        {
            "id": next(_ids),
            "ts": time.time(),
            "kind": kind,
            "category": category,
            "name": name,
            "status": status,
            "duration_ms": round(duration_ms, 1) if duration_ms is not None else None,
            "detail": detail,
            "span_id": span_id,
        }
    )


@contextlib.contextmanager
def track(category: str, name: str, detail: str | None = None):
    """Time a block as a paired start/end span. No-op when disabled.

    Safe in both sync and async call sites — the block may `await` between the
    start and end emits since this only brackets it with synchronous emits."""
    if not ENABLED:
        yield
        return
    sid = next(_span_ids)
    emit_event("span", category, name, "start", detail=detail, span_id=sid)
    t0 = time.perf_counter()
    try:
        yield
    except Exception as exc:
        emit_event(
            "span", category, name, "error",
            duration_ms=(time.perf_counter() - t0) * 1000,
            detail=f"{type(exc).__name__}: {exc}", span_id=sid,
        )
        raise
    else:
        emit_event(
            "span", category, name, "ok",
            duration_ms=(time.perf_counter() - t0) * 1000,
            detail=detail, span_id=sid,
        )


def snapshot() -> list[dict]:
    return list(_ring)


# ── stdlib logging → bus bridge ────────────────────────────────────────────────


class _BusLogHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        try:
            emit_event(
                "log",
                (record.name.split(".")[0] or "log"),
                record.getMessage(),
                record.levelname,
                detail=record.name,
            )
        except Exception:
            pass  # logging must never raise


def install_log_handler(level: int = logging.INFO) -> None:
    """Forward stdlib log records into the bus. Attached to the ROOT logger only,
    and uvicorn's loggers (which default to propagate=False) are flipped to
    propagate so their records bubble up to that single handler — attaching to
    both root and the uvicorn loggers would double-emit every line. uvicorn.access
    is silenced from the bus (the HTTP timing middleware already covers requests)."""
    if not ENABLED:
        return
    handler = _BusLogHandler()
    handler.setLevel(level)
    logging.getLogger().addHandler(handler)
    for name in ("uvicorn", "uvicorn.error"):
        logging.getLogger(name).propagate = True
    # The access logger would duplicate the middleware spans — keep it off the bus.
    logging.getLogger("uvicorn.access").propagate = False


# ── HTTP timing middleware ──────────────────────────────────────────────────────


class TimingMiddleware:
    """Pure-ASGI middleware emitting a span per HTTP request (method, path, status,
    duration). No-op when disabled. Skips the dev endpoints themselves."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not ENABLED:
            await self.app(scope, receive, send)
            return
        path = scope.get("path", "")
        if path.startswith("/api/dev"):
            await self.app(scope, receive, send)
            return

        method = scope.get("method", "")
        label = f"{method} {path}"
        status_code: dict[str, int] = {}

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                status_code["code"] = message["status"]
            await send(message)

        sid = next(_span_ids)
        emit_event("span", "http", label, "start", span_id=sid)
        t0 = time.perf_counter()
        try:
            await self.app(scope, receive, send_wrapper)
        except Exception as exc:
            emit_event(
                "span", "http", label, "error",
                duration_ms=(time.perf_counter() - t0) * 1000,
                detail=f"{type(exc).__name__}: {exc}", span_id=sid,
            )
            raise
        else:
            code = status_code.get("code", 0)
            emit_event(
                "span", "http", label, "ok" if code < 400 else "error",
                duration_ms=(time.perf_counter() - t0) * 1000,
                detail=str(code), span_id=sid,
            )


# ── endpoints (mounted in server.py) ────────────────────────────────────────────


async def events_snapshot(_: Request) -> JSONResponse:
    """Current ring buffer — initial load / non-streaming fallback for the panel."""
    return JSONResponse({"enabled": ENABLED, "events": snapshot() if ENABLED else []})


async def status_endpoint(_: Request) -> JSONResponse:
    """Lets the frontend confirm the backend half of the dev panel is actually on."""
    return JSONResponse({"enabled": ENABLED})


async def events_websocket(ws: WebSocket) -> None:
    """Stream the backlog then live events. Refused (1008) when disabled."""
    if not ENABLED:
        await ws.close(code=1008)
        return
    await ws.accept()
    q: asyncio.Queue = asyncio.Queue(maxsize=2000)
    _subscribers.add(q)

    async def _pump():
        await ws.send_json({"type": "backlog", "events": snapshot()})
        while True:
            await ws.send_json({"type": "event", "event": await q.get()})

    async def _drain():
        # Detect client disconnect (clients never send data).
        while True:
            await ws.receive_text()

    pump = asyncio.create_task(_pump())
    drain = asyncio.create_task(_drain())
    try:
        await asyncio.wait({pump, drain}, return_when=asyncio.FIRST_COMPLETED)
    except Exception:
        pass
    finally:
        for t in (pump, drain):
            t.cancel()
        _subscribers.discard(q)
