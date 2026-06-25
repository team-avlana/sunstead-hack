"""Rainy MCP server (FastMCP 3.x, stdio).

The user's local Claude Code — and Rainy's real-time model router — connect here to read
app data and drive the infinite canvas. Stdout is the MCP channel: ALL logging goes to stderr.

Read before extending:
  ../knowledge-base/mcp/fastmcp.md
  ../knowledge-base/mcp/claude-code-mcp-integration.md
  ../knowledge-base/architecture-patterns/realtime-app-ipc.md
"""
from __future__ import annotations

import json
import sys
from contextlib import asynccontextmanager
from typing import Annotated, Any

from fastmcp import FastMCP

from . import db, events


# ---- lifespan: open the shared store once, bootstrap schema for dev runs ----------------
@asynccontextmanager
async def lifespan(_server: FastMCP):
    conn = db.connect()
    db.ensure_schema(conn)
    print("[rainy-mcp] connected to shared store", file=sys.stderr)
    try:
        yield {"conn": conn}
    finally:
        conn.close()


mcp = FastMCP("rainy", lifespan=lifespan)


def _conn(ctx) -> Any:
    return ctx.request_context.lifespan_context["conn"]


# ---- read tools -------------------------------------------------------------------------
@mcp.tool
def ping() -> str:
    """Health check. Returns 'pong' if the Rainy server is alive."""
    return "pong"


@mcp.tool
def get_app_state(ctx) -> dict:
    """High-level snapshot: counts of creators, videos, projects, and pending jobs."""
    c = _conn(ctx)
    def n(sql: str) -> int:
        return c.execute(sql).fetchone()[0]
    return {
        "creators": n("SELECT count(*) FROM creator"),
        "videos": n("SELECT count(*) FROM video"),
        "projects": n("SELECT count(*) FROM project"),
        "pending_jobs": n("SELECT count(*) FROM job WHERE status='pending'"),
    }


@mcp.tool
def list_videos(
    ctx,
    creator_id: Annotated[str | None, "Filter to one creator, or omit for all"] = None,
    limit: Annotated[int, "Max rows"] = 50,
) -> list[dict]:
    """List videos (most recent first) with title, platform, and download status."""
    c = _conn(ctx)
    if creator_id:
        rows = c.execute(
            "SELECT v.id, v.title, c.platform, v.download_status, v.url "
            "FROM video v JOIN creator c ON c.id=v.creator_id "
            "WHERE v.creator_id=? ORDER BY v.created_at DESC LIMIT ?",
            (creator_id, limit),
        ).fetchall()
    else:
        rows = c.execute(
            "SELECT v.id, v.title, c.platform, v.download_status, v.url "
            "FROM video v LEFT JOIN creator c ON c.id=v.creator_id "
            "ORDER BY v.created_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [dict(r) for r in rows]


@mcp.tool
def get_canvas(ctx, project_id: str) -> dict:
    """Return all nodes and edges for a project's canvas."""
    c = _conn(ctx)
    nodes = [dict(r) for r in c.execute(
        "SELECT id, type, x, y, w, h, z, payload_json, ref_kind, ref_id "
        "FROM canvas_node WHERE project_id=?", (project_id,)).fetchall()]
    edges = [dict(r) for r in c.execute(
        "SELECT id, from_node_id, to_node_id, kind, label "
        "FROM canvas_edge WHERE project_id=?", (project_id,)).fetchall()]
    return {"project_id": project_id, "nodes": nodes, "edges": edges}


# ---- canvas mutation tools (these power the real-time agent loop) ------------------------
@mcp.tool
def canvas_add_node(
    ctx,
    project_id: str,
    type: Annotated[str, "Node kind, e.g. 'note', 'idea', 'video', 'creator'"] = "note",
    x: float = 0.0,
    y: float = 0.0,
    text: Annotated[str | None, "Optional text payload"] = None,
    ref_kind: Annotated[str | None, "Linked entity kind: creator|video|scene|analysis"] = None,
    ref_id: Annotated[str | None, "Linked entity id"] = None,
) -> dict:
    """Add a node to a project's canvas (world coordinates). Returns the new node id."""
    c = _conn(ctx)
    node_id = db.new_id()
    payload = json.dumps({"text": text}) if text is not None else None
    c.execute(
        "INSERT INTO canvas_node (id, project_id, type, x, y, payload_json, ref_kind, ref_id) "
        "VALUES (?,?,?,?,?,?,?,?)",
        (node_id, project_id, type, x, y, payload, ref_kind, ref_id),
    )
    events.emit("canvas.node_added",
                {"project_id": project_id, "node_id": node_id, "type": type, "x": x, "y": y})
    return {"id": node_id}


@mcp.tool
def canvas_move_node(ctx, node_id: str, x: float, y: float) -> dict:
    """Move a canvas node to new world coordinates."""
    c = _conn(ctx)
    row = c.execute("SELECT project_id FROM canvas_node WHERE id=?", (node_id,)).fetchone()
    if row is None:
        raise ValueError(f"node {node_id} not found")
    c.execute("UPDATE canvas_node SET x=?, y=?, updated_at=datetime('now') WHERE id=?",
              (x, y, node_id))
    events.emit("canvas.node_moved",
                {"project_id": row["project_id"], "node_id": node_id, "x": x, "y": y})
    return {"id": node_id, "x": x, "y": y}


@mcp.tool
def canvas_connect(
    ctx,
    project_id: str,
    from_node_id: str,
    to_node_id: str,
    label: str | None = None,
    kind: str = "relates",
) -> dict:
    """Create an edge between two canvas nodes. Returns the new edge id."""
    c = _conn(ctx)
    edge_id = db.new_id()
    c.execute(
        "INSERT INTO canvas_edge (id, project_id, from_node_id, to_node_id, kind, label) "
        "VALUES (?,?,?,?,?,?)",
        (edge_id, project_id, from_node_id, to_node_id, kind, label),
    )
    events.emit("canvas.edge_added",
                {"project_id": project_id, "edge_id": edge_id,
                 "from": from_node_id, "to": to_node_id})
    return {"id": edge_id}


def main() -> None:
    # stdio is FastMCP's default transport. Never print to stdout elsewhere.
    mcp.run()


if __name__ == "__main__":
    main()
