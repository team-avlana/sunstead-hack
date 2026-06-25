"""
python-service — MCP server + websocket notification hub.

Start with:
    python server.py
or:
    python -m uvicorn server:app --host 127.0.0.1 --port 9000

FastMCP 3.x serves over streamable-HTTP (Starlette under the hood).
We obtain the ASGI app from FastMCP and mount it inside our own Starlette
app that also declares the /ws WebSocketRoute.
"""

import asyncio
from contextlib import asynccontextmanager

import uvicorn
from fastmcp import FastMCP
from starlette.applications import Starlette
from starlette.middleware.cors import CORSMiddleware
from starlette.routing import Mount, WebSocketRoute

import db
import notify
import pty_bridge
from config import settings
from routes_api import routes as api_routes
from tools import analysis, artifacts, creators, memory, projects

# ── FastMCP instance ──────────────────────────────────────────────────────────

mcp = FastMCP(
    name="sunstead",
    instructions=(
        "Video preproduction assistant. Use these tools to manage projects, "
        "trigger video/channel analysis, create and update canvas artifacts, "
        "and store memory about goals, audience, and creative direction."
    ),
)

# Register all tool groups
projects.register(mcp)
analysis.register(mcp)
artifacts.register(mcp)
memory.register(mcp)
creators.register(mcp)

# ── Combined ASGI app ─────────────────────────────────────────────────────────

# FastMCP 3.x: http_app() returns a Starlette app whose lifespan initialises
# the internal task group. Starlette's Mount does NOT propagate sub-app
# lifespans, so we forward it explicitly via the outer app's lifespan.
_mcp_asgi = mcp.http_app()


@asynccontextmanager
async def lifespan(app: Starlette):
    async with _mcp_asgi.router.lifespan_context(app):
        # Bridge cross-process changes (analysis-worker, analyze_video) to WS.
        listener = asyncio.create_task(notify.pg_listen(settings.db.connection_string))
        try:
            yield
        finally:
            listener.cancel()
            try:
                await listener
            except asyncio.CancelledError:
                pass
            db.close_pool()


_app = Starlette(
    lifespan=lifespan,
    routes=[
        # Order matters: specific routes before the catch-all MCP mount at "/".
        WebSocketRoute("/ws", notify.websocket_endpoint),
        # Hosts the user's own `claude` CLI in a PTY for the canvas right panel.
        WebSocketRoute("/pty", pty_bridge.terminal_endpoint),
        *api_routes,
        Mount("/", app=_mcp_asgi),
    ],
)

# NOTE: wildcard CORS + no auth is intended for LOCAL use only — the server binds
# 127.0.0.1. Before any non-local/exposed deployment, restrict allow_origins to the
# known canvas origin(s), add an Origin check on the /ws handshake (CORS does not
# cover websockets), and require a token on the write tools. A malicious local web
# page can otherwise drive the MCP write surface via DNS-rebinding/cross-origin.
app = CORSMiddleware(
    _app,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["mcp-session-id"],
)

# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    uvicorn.run(
        "server:app",
        host=settings.server.host,
        port=settings.server.port,
        reload=False,
    )
