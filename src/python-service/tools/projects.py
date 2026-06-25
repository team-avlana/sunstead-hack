from fastmcp import FastMCP
import db


def register(mcp: FastMCP) -> None:

    @mcp.tool()
    def create_project(name: str) -> dict:
        """
        Create a new preproduction project. Returns {project_id}.

        A project is the container for all canvas artifacts (ideation frames,
        storyboards, shot lists, scripts) related to one video or campaign.
        Create one per video or content series.
        """
        if not name or not name.strip():
            raise ValueError("name must not be empty")
        return db.create_project(name.strip())

    @mcp.tool()
    def list_projects() -> list:
        """
        List all active projects. Returns [{project_id, name, created_at}].

        Use this to find an existing project_id before creating artifacts or
        memories, or to resume work on a previous video.
        """
        return db.list_projects()
