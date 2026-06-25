from fastmcp import FastMCP

import active_project
import db


def register(mcp: FastMCP) -> None:

    @mcp.tool()
    def create_project(name: str) -> dict:
        """Create a new preproduction project. Returns the new project_id."""
        if not name or not name.strip():
            raise ValueError("name must not be empty")
        return db.create_project(name.strip())

    @mcp.tool()
    def list_projects() -> list:
        """List all active projects. Returns [{project_id, name, created_at}]."""
        return db.list_projects()

    @mcp.tool()
    def get_active_project() -> dict:
        """Which project the user currently has open on the canvas.

        Returns {project_id, name}; both are null when the user is on the Home
        screen (no project open). The project-scoped tools (create_artifact,
        list_artifacts) default to this project when you omit project_id, so you
        normally don't need to ask the user which project they mean — just read
        it from here."""
        return active_project.get_active()
