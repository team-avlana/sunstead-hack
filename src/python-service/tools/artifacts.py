"""Artifact tools — each write also broadcasts a websocket change signal."""

import asyncio
from typing import Any, Optional

from fastmcp import FastMCP
from starlette.concurrency import run_in_threadpool

import active_project
import db
import notify
from block_normalize import BLOCK_TAXONOMY_GUIDE, WRITING_STYLE_GUIDE


# Tool descriptions are built from the shared block-taxonomy guide so the agent
# learns the full block vocabulary (types, formats, which fields to fill) on every
# write tool. FastMCP only treats a plain string literal as a docstring, so we pass
# these as explicit `description=` to the decorator instead of interpolating inline.
_CREATE_ARTIFACT_DESC = (
    """\
Create a frame (a "flow") on the canvas for a project. The canvas renders it live. A
frame is one artifact; the blocks it contains live inside its payload as `elements`.

project_id defaults to the project the user currently has open on the canvas (see
get_active_project); pass it explicitly only to target a different one.

type: 'frame'  (e.g. an Ideation flow, a Storyboarding flow)
payload: {
  "label": str,            # frame title shown on the canvas
  "role": str (optional),  # e.g. "ideation" | "storyboard"
  "elements": [ <blocks — see BLOCK TAXONOMY below> ]
}
Example elements:
  {"id": "el-1", "type": "text", "format": "title",
   "title": "Hook", "body": "Line one.\\nLine two.", "x": 24, "y": 64, "w": 320, "h": 200}
  {"id": "el-2", "type": "video", "view": "compact", "video_id": "…", "x": 360, "y": 64}
  {"id": "el-3", "type": "image", "src": "/frames/{frame_id}", "frame_id": "…",
   "caption": "Scene 1", "x": 0, "y": 0, "w": 320, "h": 180}

For storyboards: call get_video_analysis (or get_video_shots) to get each shot's
frame_id, then create one image element per scene (src="/frames/{frame_id}") paired with
a text element for the scene label/description.

Address one block later with update_artifact(id, element_id=<el.id>, element_patch={…}).
position: {x, y, w, h} = the frame box on the canvas.

Returns {artifact_id}.

"""
    + BLOCK_TAXONOMY_GUIDE
    + "\n\n"
    + WRITING_STYLE_GUIDE
)

_UPDATE_ARTIFACT_DESC = (
    """\
Update an existing artifact. Bumps version so the canvas can detect changes.

Two update modes:
- Whole-payload replace: pass payload={…}.
- Addressed element update: pass element_id + element_patch to merge into the single
  element within payload.elements that has the matching id.

For a text element, patch only the structured parts you want to change, e.g.
element_patch={"format": "title-sub", "subtitle": "…"} or {"body": "…"}; the canonical
content/format are rebuilt from the merged parts. When you change `format`, also supply
the fields that format needs (e.g. switching to "title" wants a `title`). For a video
element, patch {"view": "expanded"} to change its detail level.

Also supports updating position and/or title independently.
Returns {artifact_id, version}.

"""
    + BLOCK_TAXONOMY_GUIDE
    + "\n\n"
    + WRITING_STYLE_GUIDE
)


# Resolve a tool's project_id: explicit arg wins, else the project the canvas
# currently has open. Raises a helpful error when neither is available.
def _resolve_project_id(project_id: Optional[str]) -> str:
    pid = project_id or active_project.get_active_id()
    if not pid:
        raise ValueError(
            "No project_id given and no project is open on the canvas. "
            "Open a project on the canvas, or pass project_id explicitly."
        )
    return pid


def register(mcp: FastMCP) -> None:

    @mcp.tool(description=_CREATE_ARTIFACT_DESC)
    async def create_artifact(
        project_id: Optional[str] = None,
        type: Optional[str] = None,
        title: Optional[str] = None,
        payload: Optional[dict] = None,
        position: Optional[dict] = None,
    ) -> dict:
        project_id = _resolve_project_id(project_id)
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

    @mcp.tool(description=_UPDATE_ARTIFACT_DESC)
    async def update_artifact(
        artifact_id: str,
        payload: Optional[dict] = None,
        element_id: Optional[str] = None,
        element_patch: Optional[dict] = None,
        position: Optional[dict] = None,
        title: Optional[str] = None,
    ) -> dict:
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
    def list_artifacts(project_id: Optional[str] = None) -> list:
        """
        List all active (non-deleted) artifacts for a project (for the agent;
        the canvas reads the DB directly).

        project_id defaults to the project the user currently has open on the canvas.
        Use this to see what is already on the canvas before creating new artifacts,
        so you can update existing ones rather than duplicating them.
        Returns [{artifact_id, type, title, payload, position, version, created_at}].
        """
        return db.list_artifacts(_resolve_project_id(project_id))

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
