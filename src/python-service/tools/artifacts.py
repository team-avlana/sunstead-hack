"""Artifact tools — each write also broadcasts a websocket change signal."""

import asyncio
from typing import Any, Optional

from fastmcp import FastMCP

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
        Create a new artifact on the canvas for a project.

        type: storyboard | shot_list | idea_board | script_doc | mood_board | diagram
        payload: the typed content of the artifact (element ids live inside it).
        position: {x, y, w, h} placement hint for the canvas.

        Returns {artifact_id}.
        """
        if not project_id:
            raise ValueError("project_id is required")
        if not type:
            raise ValueError("type is required")

        result = db.create_artifact(
            project_id=project_id,
            type_=type,
            title=title,
            payload=payload or {},
            position=position,
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

        result = db.update_artifact(
            artifact_id=artifact_id,
            payload=payload,
            element_id=element_id,
            element_patch=element_patch,
            position=position,
            title=title,
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
        result = db.delete_artifact(artifact_id)
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
