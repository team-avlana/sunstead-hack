#!/usr/bin/env python3
"""Seed a "Video Block" demo project by driving the MCP server over HTTP — the
same path the Claude agent uses. Picks real videos (in each analysis state) from
Postgres, then calls create_project + create_artifact through the MCP tools.

Run the python-service first (python server.py), then:
    ../python-service/.venv/bin/python seed_demo.py

Idempotent: reuses the demo project if it already has video blocks.
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

HERE = Path(__file__).resolve().parent
MCP_URL = os.environ.get("RAINY_MCP_URL", "http://127.0.0.1:9000/mcp")
DEMO_NAME = "Rainy — Video Block Demo"


def _dsn() -> str:
    try:
        from dotenv import load_dotenv

        load_dotenv(HERE.parent / "python-service" / ".env")
    except ImportError:
        pass
    dsn = os.environ.get("DB_CONNECTION_STRING", "")
    if not dsn:
        raise SystemExit("DB_CONNECTION_STRING not set")
    return dsn


def pick_videos(dsn: str) -> dict:
    """Find real videos for each lifecycle state (distinct titles where possible)."""
    with psycopg.connect(dsn, row_factory=dict_row) as c, c.cursor() as cur:
        cur.execute(
            "SELECT id, title, duration_sec FROM videos "
            "WHERE analyzed_at IS NOT NULL AND analysis_error IS NULL AND deleted_at IS NULL "
            "ORDER BY duration_sec DESC NULLS LAST"
        )
        analysed, seen = [], set()
        for r in cur.fetchall():
            key = (r["title"] or "").strip().lower()
            if key in seen:
                continue
            seen.add(key)
            analysed.append(r)

        cur.execute(
            "SELECT id, title FROM videos "
            "WHERE analyzed_at IS NULL AND analysis_error IS NULL AND deleted_at IS NULL LIMIT 1"
        )
        analysing = cur.fetchone()

        cur.execute(
            "SELECT id, title FROM videos "
            "WHERE analysis_error IS NOT NULL AND deleted_at IS NULL LIMIT 1"
        )
        errored = cur.fetchone()

    return {"analysed": analysed, "analysing": analysing, "errored": errored}


def find_demo_project(dsn: str) -> tuple[str | None, int]:
    with psycopg.connect(dsn, row_factory=dict_row) as c, c.cursor() as cur:
        cur.execute(
            "SELECT id FROM projects WHERE name = %s AND deleted_at IS NULL ORDER BY created_at LIMIT 1",
            (DEMO_NAME,),
        )
        row = cur.fetchone()
        if not row:
            return None, 0
        pid = str(row["id"])
        cur.execute(
            "SELECT count(*) AS n FROM artifacts WHERE project_id = %s AND type = 'video' AND deleted_at IS NULL",
            (pid,),
        )
        return pid, cur.fetchone()["n"]


def build_blocks(picked: dict) -> list[dict]:
    """Lay out the 7 demo Video Blocks (3 disclosure levels + each state)."""
    analysed = picked["analysed"]
    full = analysed[0]["id"] if len(analysed) > 0 else None
    expanded = analysed[1]["id"] if len(analysed) > 1 else full
    compact = analysed[2]["id"] if len(analysed) > 2 else expanded
    analysing = picked["analysing"]["id"] if picked["analysing"] else None
    errored = picked["errored"]["id"] if picked["errored"] else None

    blocks: list[dict] = []

    def vid(video_id, view, x, y, title=None):
        payload = {"kind": "video", "video_id": str(video_id), "view": view}
        if title:
            payload["title"] = title
        blocks.append({"title": title or "Video", "payload": payload, "position": {"x": x, "y": y}})

    def placeholder(state, view, x, y, title=None):
        payload = {"kind": "video", "state": state, "view": view}
        if title:
            payload["title"] = title
        blocks.append({"title": title or state, "payload": payload, "position": {"x": x, "y": y}})

    if compact:
        vid(compact, "compact", 80, 80)
    if expanded:
        vid(expanded, "expanded", 500, 80)
    if full:
        vid(full, "full", 940, 80)
    if analysing:
        vid(analysing, "expanded", 80, 560, title="New upload — analysing…")
    if errored:
        vid(errored, "expanded", 500, 560)
    placeholder("not_analysed", "expanded", 80, 820, title="Draft idea — morning routine")
    placeholder("empty", "expanded", 500, 820)
    return blocks


async def main() -> None:
    from fastmcp import Client

    dsn = _dsn()
    picked = pick_videos(dsn)
    print(f"Picked videos: analysed={len(picked['analysed'])} "
          f"analysing={'yes' if picked['analysing'] else 'no'} "
          f"error={'yes' if picked['errored'] else 'no'}")

    existing_id, n_video = find_demo_project(dsn)
    if existing_id and n_video > 0:
        print(f"Demo project already seeded: {existing_id} ({n_video} video blocks)")
        print(f"Open: #/p/{existing_id}")
        return

    blocks = build_blocks(picked)

    async with Client(MCP_URL) as client:
        if existing_id:
            project_id = existing_id
            print(f"Reusing empty demo project {project_id}")
        else:
            res = await client.call_tool("create_project", {"name": DEMO_NAME})
            project_id = res.data["project_id"]
            print(f"Created project {project_id}")

        for b in blocks:
            r = await client.call_tool(
                "create_artifact",
                {
                    "project_id": project_id,
                    "type": "video",
                    "title": b["title"],
                    "payload": b["payload"],
                    "position": b["position"],
                },
            )
            print(f"  + video block {r.data.get('artifact_id')}  ({b['payload'].get('view')}, "
                  f"{b['payload'].get('video_id', b['payload'].get('state'))})")

    print(f"\nDone. Open the canvas at  #/p/{project_id}")


if __name__ == "__main__":
    asyncio.run(main())
