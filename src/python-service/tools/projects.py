from fastmcp import FastMCP
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
