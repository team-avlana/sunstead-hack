from typing import Optional

from fastmcp import FastMCP

import db


def register(mcp: FastMCP) -> None:

    @mcp.tool()
    def save_memory(
        kind: str,
        value: str,
        key: Optional[str] = None,
        data: Optional[dict] = None,
        project_id: Optional[str] = None,
    ) -> dict:
        """
        Persist a memory entry that survives across sessions.

        Call list_memory() at session start to reload saved context before
        asking the user questions they've already answered.

        project_id=None means user-level (applies to all projects).
        Set project_id to scope a memory to a specific project.

        kind values and what to save:
          goal        — what the creator is trying to achieve (growth, monetisation, etc.)
          audience    — who they're making content for (age, interest, platform context)
          platform    — target platform and format constraints (YouTube Shorts, long-form, etc.)
          constraint  — hard limits (budget, filming location, equipment, time per video)
          preference  — style/tone preferences, things to always or never do
          note        — anything else worth remembering across sessions

        key: short label for filtering (e.g. 'target_audience', 'upload_cadence')
        value: the human-readable fact to remember
        data: optional structured supplement for machine-readable fields

        Returns {memory_id}.
        """
        if kind not in db.VALID_MEMORY_KINDS:
            raise ValueError(f"kind must be one of: {', '.join(sorted(db.VALID_MEMORY_KINDS))}")
        if not value:
            raise ValueError("value must not be empty")
        return db.save_memory(kind=kind, value=value, key=key, data=data, project_id=project_id)

    @mcp.tool()
    def list_memory(
        project_id: Optional[str] = None,
        kind: Optional[str] = None,
    ) -> list:
        """
        List memory entries. Call this at session start to reload context.

        project_id=None returns user-level memories (goals, audience, preferences, etc.).
        Pass a project_id to also see project-scoped memories.
        Optionally filter by kind (goal | audience | platform | constraint | preference | note).

        Returns [{memory_id, kind, key, value, data, project_id, created_at}].
        """
        return db.list_memory(project_id=project_id, kind=kind)

    @mcp.tool()
    def delete_memory(memory_id: str) -> dict:
        """Soft-delete a memory entry. Returns {ok: true}."""
        ok = db.delete_memory(memory_id)
        if not ok:
            raise ValueError(f"Memory {memory_id} not found")
        return {"ok": True}
