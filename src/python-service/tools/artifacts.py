"""Artifact tools — each write also broadcasts a websocket change signal."""

import asyncio
from typing import Any, Optional

from fastmcp import FastMCP
from starlette.concurrency import run_in_threadpool

import db
import notify


def register(mcp: FastMCP) -> None:

    @mcp.tool()
    async def create_artifact(
        project_id: str,
        type: str,
        title: Optional[str] = None,
        payload: Optional[dict] = None,
        position: Optional[dict] = None,
    ) -> dict:
        """
        Create a frame on the canvas. The canvas renders it live. Call this
        throughout the preproduction workflow to visualise each phase.

        Be as visual as possible — create artifacts early and keep iterating with
        update_artifact rather than creating duplicates.

        type: 'frame'

        payload: {
          "label": str,         # title shown on the canvas frame header
          "role": str,          # phase hint: "research" | "ideation" | "script" |
                                #             "storyboard" | "shot_list" | "reference"
          "elements": [
            {
              "id": "el-1",          # stable id — required for update_artifact targeting
              "type": "text",
              "content": "<p>…</p>", # HTML supported: <p> <strong> <em> <ul> <li>
              "x": 24, "y": 64, "w": 320, "h": 200
            },
            {
              "id": "el-2",
              "type": "video",
              "video_id": "…",
              "view": "compact",     # "compact" | "full"
              "x": 360, "y": 64
            },
            {
              "id": "el-3",
              "type": "image",
              "src": "/frames/{frame_id}",   # real frame from a video shot
              "frame_id": "…",               # UUID from get_video_shots
              "caption": "Scene 1",          # optional
              "x": 0, "y": 0, "w": 320, "h": 180
            }
          ]
        }

        Storyboard pattern: call get_video_shots(video_id) → for each scene create
        an image element (src='/frames/{frame_id}') and a paired text element for the
        scene label. x/y coordinates are RELATIVE to the frame's top-left corner.

        position: {x, y, w, h} — where to place the frame on the infinite canvas.
        Avoid overlapping: offset x by (prev_w + 80) per new frame.

        Returns {artifact_id}.
        """
        if not project_id:
            raise ValueError("project_id is required")
        if not type:
            raise ValueError("type is required")

        # Run the blocking psycopg-pool call off the event loop so it never
        # starves pg_listen / websocket delivery / the MCP transport.
        result = await run_in_threadpool(
            lambda: db.create_artifact(
                project_id=project_id,
                type_=type,
                title=title,
                payload=payload or {},
                position=position,
            )
        )
        await notify.broadcast(
            {
                "type": "artifact",
                "action": "created",
                "artifact_id": result["artifact_id"],
                "project_id": project_id,
                "version": 1,
            },
            project_id=project_id,
        )
        return {"artifact_id": result["artifact_id"]}

    @mcp.tool()
    async def update_artifact(
        artifact_id: str,
        payload: Optional[dict] = None,
        element_id: Optional[str] = None,
        element_patch: Optional[dict] = None,
        position: Optional[dict] = None,
        title: Optional[str] = None,
    ) -> dict:
        """
        Update an existing artifact. Bumps version so the canvas detects the change.

        Prefer this over create_artifact when iterating — never create a duplicate
        artifact when you can update the existing one.

        Two update modes:
        - Whole-payload replace: pass payload={...} to replace all elements at once.
        - Addressed element update: pass element_id (the "id" field of one element)
          + element_patch to merge only into that element, leaving others untouched.
          Use this to revise a single scene in a storyboard or fix one line of a script.

        Also supports updating position and/or title independently (pass without payload).
        Returns {artifact_id, version}.
        """
        if not artifact_id:
            raise ValueError("artifact_id is required")

        result = await run_in_threadpool(
            lambda: db.update_artifact(
                artifact_id=artifact_id,
                payload=payload,
                element_id=element_id,
                element_patch=element_patch,
                position=position,
                title=title,
            )
        )
        if result is None:
            raise ValueError(f"Artifact {artifact_id} not found")

        await notify.broadcast(
            {
                "type": "artifact",
                "action": "updated",
                "artifact_id": artifact_id,
                "project_id": result["project_id"],
                "version": result["version"],
            },
            project_id=result["project_id"],
        )
        return {"artifact_id": artifact_id, "version": result["version"]}

    @mcp.tool()
    def get_artifact(artifact_id: str) -> dict:
        """
        Read back a single artifact by id. Use this to inspect current element ids
        before doing an addressed element update via update_artifact.
        """
        result = db.get_artifact(artifact_id)
        if result is None:
            raise ValueError(f"Artifact {artifact_id} not found")
        return result

    @mcp.tool()
    def list_artifacts(project_id: str) -> list:
        """
        List all active (non-deleted) artifacts for a project.

        Use this to see what is already on the canvas before creating new artifacts,
        so you can update existing ones rather than duplicating them.
        Returns [{artifact_id, type, title, payload, position, version, created_at}].
        """
        return db.list_artifacts(project_id)

    @mcp.tool()
    async def delete_artifact(artifact_id: str) -> dict:
        """
        Soft-delete an artifact (sets deleted_at). Notifies the canvas.
        Returns {ok: true}.
        """
        result = await run_in_threadpool(db.delete_artifact, artifact_id)
        if result is None:
            raise ValueError(f"Artifact {artifact_id} not found")

        await notify.broadcast(
            {
                "type": "artifact",
                "action": "deleted",
                "artifact_id": artifact_id,
                "project_id": result["project_id"],
                "version": 0,
            },
            project_id=result["project_id"],
        )
        return {"ok": True}
