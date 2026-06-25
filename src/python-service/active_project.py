"""In-process record of which project the canvas currently has open.

The canvas (an HTTP client) PUTs the open project here whenever the user opens
one or returns Home; the MCP tools the embedded `claude` calls read it back, so
project-scoped tools default to "the project the user is looking at" instead of
making the user paste an id. This is the seam that keeps the single long-lived
Claude session aware of context as the user moves around the canvas.

Both the HTTP API and the MCP tools run in the same server process (see
server.py), so a module-level value is shared between them. This is a
single-user, 127.0.0.1-only service, so a plain dict is sufficient — no DB row,
no lock (assignment is atomic and there is exactly one writer: the canvas).
"""

from typing import Optional

_active: dict = {"project_id": None, "name": None}


def set_active(project_id: Optional[str], name: Optional[str] = None) -> None:
    """Record the project the canvas now has open (None = Home / nothing open)."""
    _active["project_id"] = project_id or None
    _active["name"] = name or None


def get_active() -> dict:
    """The open project as {project_id, name}; both None when on the Home screen."""
    return dict(_active)


def get_active_id() -> Optional[str]:
    """Just the open project's id, or None when nothing is open."""
    return _active["project_id"]
