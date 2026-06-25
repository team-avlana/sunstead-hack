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
        Create a frame (a "flow") on the canvas for a project. The canvas renders it
        live. A frame is one artifact; the blocks it contains live inside its payload
        as elements.

        type: 'frame'  (e.g. an Ideation flow, a Storyboarding flow)
        payload: {
          "label": str,               # frame title shown on the canvas
          "role": str (optional),     # e.g. "ideation" | "storyboard"
          "elements": [               # the blocks inside this frame
            {"id": "el-1", "type": "text",  "content": "<p>…</p>", "x": 24, "y": 64, "w": 320, "h": 200},
            {"id": "el-2", "type": "video", "video_id": "…", "view": "compact", "x": 360, "y": 64},
            {"id": "el-3", "type": "image", "src": "/frames/{frame_id}", "frame_id": "…",
             "caption": str (optional), "x": 0, "y": 0, "w": 320, "h": 180}
          ]
        }
        For storyboards: use get_video_analysis to get shots_summary (each shot has a
        frame_id), then create one image element per scene using src="/frames/{frame_id}".
        Pair each image element with a text element for the scene label/description.
        Each element needs a stable "id"; x/y are RELATIVE to the frame's top-left.
        Address one block later with update_artifact(id, element_id=<el.id>, element_patch={...}).
        position: {x, y, w, h} = the frame box on the canvas.

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
        Update an existing artifact. Bumps version so the canvas can detect changes.

        Two update modes:
        - Whole-payload replace: pass payload={...}.
        - Addressed element update: pass element_id + element_patch to merge into
          a single element within payload.elements that has the matching id.

        Also supports updating position and/or title independently.
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
        Read back a single artifact by id (for the agent; the canvas reads from DB directly).
        """
        result = db.get_artifact(artifact_id)
        if result is None:
            raise ValueError(f"Artifact {artifact_id} not found")
        return result

    @mcp.tool()
    def list_artifacts(project_id: str) -> list:
        """
        List all active artifacts for a project (for the agent; canvas reads DB directly).
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
