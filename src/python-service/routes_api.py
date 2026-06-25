"""Read-only HTTP API for the canvas-ui (a static export that cannot open Postgres
directly). Mounted alongside the MCP server in server.py.

    GET /api/health
    GET /api/projects
    GET /api/projects/{project_id}     -> {project, artifacts:[enriched]}
    GET /api/artifacts/{artifact_id}   -> enriched artifact (re-pull on WS signal)
    GET /api/videos/{video_id}         -> {video, shots_summary}
    GET /frames/{video_id}/{name}      -> a shot frame image if present (else 404)

"Enriched" = a `type:'video'` artifact gets a live `video` view-model attached,
joined from the videos table via payload.video_id (see video_view.derive_video).
"""

from __future__ import annotations

import os
from pathlib import Path

from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse
from starlette.routing import Route

import db
import video_view

# Where the analysis-worker writes frames (best-effort serving; missing -> 404).
_FRAMES_ROOT = Path(os.environ.get("FRAMES_DIR", "../analysis-worker/workdir")).resolve()


def _enrich_artifact(artifact: dict) -> dict:
    """Attach a live `video` view-model to video artifacts."""
    if artifact.get("type") != "video":
        return artifact
    payload = artifact.get("payload") or {}
    video_id = payload.get("video_id") if isinstance(payload, dict) else None
    if not video_id:
        # Placeholder block (empty / ready-for-input) — state lives in the payload.
        state = (payload.get("state") if isinstance(payload, dict) else None) or "empty"
        artifact["video"] = {"video_id": None, "status": state, "tags": [], "storyboard": []}
        return artifact
    full = db.get_video_full(video_id)
    if full is None:
        artifact["video"] = {"video_id": video_id, "status": "not_analysed", "tags": [], "storyboard": []}
    else:
        artifact["video"] = video_view.derive_video(full["video"], full["shots"])
    return artifact


# ── handlers ───────────────────────────────────────────────────────────────────

async def health(_: Request) -> JSONResponse:
    try:
        await run_in_threadpool(db.list_projects)
        return JSONResponse({"ok": True, "db": True})
    except Exception:  # pragma: no cover
        # Don't echo the exception — it can contain the DB DSN/credentials.
        return JSONResponse({"ok": False, "db": False}, status_code=503)


async def list_projects(_: Request) -> JSONResponse:
    projects = await run_in_threadpool(db.list_projects)
    return JSONResponse({"projects": projects})


async def get_project(request: Request) -> JSONResponse:
    pid = request.path_params["project_id"]
    project = await run_in_threadpool(db.get_project, pid)
    if project is None:
        return JSONResponse({"error": "project not found"}, status_code=404)
    artifacts = await run_in_threadpool(db.list_artifacts, pid)
    enriched = [await run_in_threadpool(_enrich_artifact, a) for a in artifacts]
    return JSONResponse({"project": project, "artifacts": enriched})


async def get_artifact(request: Request) -> JSONResponse:
    aid = request.path_params["artifact_id"]
    artifact = await run_in_threadpool(db.get_artifact, aid)
    if artifact is None:
        return JSONResponse({"error": "artifact not found"}, status_code=404)
    artifact = await run_in_threadpool(_enrich_artifact, artifact)
    return JSONResponse({"artifact": artifact})


async def get_video(request: Request) -> JSONResponse:
    vid = request.path_params["video_id"]
    full = await run_in_threadpool(db.get_video_full, vid)
    if full is None:
        return JSONResponse({"error": "video not found"}, status_code=404)
    view = video_view.derive_video(full["video"], full["shots"])
    shots_summary = [
        {"idx": s["idx"], "start_sec": float(s["start_sec"]), "end_sec": float(s["end_sec"])}
        for s in full["shots"]
    ]
    return JSONResponse({"video": view, "shots_summary": shots_summary})


async def get_frame(request: Request):
    vid = request.path_params["video_id"]
    name = os.path.basename(request.path_params["name"])  # prevent traversal
    candidate = (_FRAMES_ROOT / vid / "frames" / name).resolve()
    # Stay within the frames root.
    if _FRAMES_ROOT in candidate.parents and candidate.is_file():
        return FileResponse(str(candidate))
    return JSONResponse({"error": "frame not found"}, status_code=404)


routes = [
    Route("/api/health", health),
    Route("/api/projects", list_projects),
    Route("/api/projects/{project_id}", get_project),
    Route("/api/artifacts/{artifact_id}", get_artifact),
    Route("/api/videos/{video_id}", get_video),
    Route("/frames/{video_id}/{name}", get_frame),
]
