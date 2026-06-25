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
        Persist a memory entry. project_id=None means user-level (spans projects).

        kind: goal | audience | platform | constraint | preference | note
        key: optional short label (e.g. 'target_audience')
        value: the human-readable fact to remember
        data: optional structured supplement

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
        List memory entries. project_id=None returns user-level memories.
        Optionally filter by kind.
        """
        return db.list_memory(project_id=project_id, kind=kind)

    @mcp.tool()
    def delete_memory(memory_id: str) -> dict:
        """Soft-delete a memory entry. Returns {ok: true}."""
        ok = db.delete_memory(memory_id)
        if not ok:
            raise ValueError(f"Memory {memory_id} not found")
        return {"ok": True}
