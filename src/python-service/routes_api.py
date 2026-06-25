"""HTTP API for the canvas-ui (a static export that cannot open Postgres directly).
Mounted alongside the MCP server in server.py.

    GET    /api/health
    GET    /api/projects
    GET    /api/projects/{project_id}        -> {project, artifacts:[enriched]}
    GET    /api/artifacts/{artifact_id}      -> enriched artifact
    PUT    /api/artifacts/{artifact_id}      -> update; broadcasts WS change signal
    DELETE /api/artifacts/{artifact_id}      -> soft-delete; broadcasts WS change signal
    GET    /api/videos/{video_id}            -> {video, shots_summary}
    GET    /api/videos/{video_id}/status     -> lightweight status poll
    GET    /api/creators/{creator_id}/videos -> video list with status + metadata
    GET    /frames/{frame_id}               -> JPEG image served from the frames table

"Enriched" = a `type:'video'` artifact gets a live `video` view-model attached,
joined from the videos table via payload.video_id (see video_view.derive_video).
"""

from __future__ import annotations

from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

import db
import notify
import video_view


def _video_view(src: dict) -> dict:
    """Build the live video view-model for a dict that carries a video_id
    (a video element, or a legacy standalone video artifact's payload)."""
    video_id = src.get("video_id") if isinstance(src, dict) else None
    if not video_id:
        # Placeholder block (empty / ready-for-input) — state lives alongside it.
        state = (src.get("state") if isinstance(src, dict) else None) or "empty"
        return {"video_id": None, "status": state, "tags": [], "storyboard": []}
    full = db.get_video_full(video_id)
    if full is None:
        return {"video_id": video_id, "status": "not_analysed", "tags": [], "storyboard": []}
    return video_view.derive_video(full["video"], full["shots"])


def _enrich_artifact(artifact: dict) -> dict:
    """Attach live `video` view-models. For a frame, enrich each video element in
    payload.elements; for a legacy standalone video artifact, enrich it directly."""
    payload = artifact.get("payload") or {}
    if artifact.get("type") == "frame" and isinstance(payload, dict):
        for el in payload.get("elements") or []:
            if isinstance(el, dict) and el.get("type") == "video":
                el["video"] = _video_view(el)
        return artifact
    if artifact.get("type") == "video":
        artifact["video"] = _video_view(payload if isinstance(payload, dict) else {})
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


async def update_artifact(request: Request) -> JSONResponse:
    aid = request.path_params["artifact_id"]
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "invalid JSON"}, status_code=400)

    result = await run_in_threadpool(
        lambda: db.update_artifact(
            artifact_id=aid,
            payload=body.get("payload"),
            element_id=body.get("element_id"),
            element_patch=body.get("element_patch"),
            position=body.get("position"),
            title=body.get("title"),
        )
    )
    if result is None:
        return JSONResponse({"error": "artifact not found"}, status_code=404)

    await notify.broadcast(
        {
            "type": "artifact",
            "action": "updated",
            "artifact_id": aid,
            "project_id": result["project_id"],
            "version": result["version"],
        },
        project_id=result["project_id"],
    )
    return JSONResponse({"artifact_id": aid, "version": result["version"]})


async def delete_artifact(request: Request) -> JSONResponse:
    aid = request.path_params["artifact_id"]
    result = await run_in_threadpool(db.delete_artifact, aid)
    if result is None:
        return JSONResponse({"error": "artifact not found"}, status_code=404)

    await notify.broadcast(
        {
            "type": "artifact",
            "action": "deleted",
            "artifact_id": aid,
            "project_id": result["project_id"],
            "version": 0,
        },
        project_id=result["project_id"],
    )
    return JSONResponse({"ok": True})


async def get_video_status(request: Request) -> JSONResponse:
    vid = request.path_params["video_id"]
    status = await run_in_threadpool(db.get_video_status, vid)
    if status is None:
        return JSONResponse({"error": "video not found"}, status_code=404)
    return JSONResponse(status)


async def list_creator_videos(request: Request) -> JSONResponse:
    cid = request.path_params["creator_id"]
    videos = await run_in_threadpool(db.get_creator_videos, cid)
    if videos is None:
        return JSONResponse({"error": "creator not found"}, status_code=404)
    return JSONResponse({"creator_id": cid, "videos": videos})


async def get_frame(request: Request):
    frame_id = request.path_params["frame_id"]
    frame = await run_in_threadpool(db.get_frame, frame_id)
    if frame is None:
        return JSONResponse({"error": "frame not found"}, status_code=404)
    return Response(content=frame["data"], media_type=frame["mime_type"])


routes = [
    Route("/api/health", health),
    Route("/api/projects", list_projects),
    Route("/api/projects/{project_id}", get_project),
    Route("/api/artifacts/{artifact_id}", get_artifact, methods=["GET", "HEAD"]),
    Route("/api/artifacts/{artifact_id}", update_artifact, methods=["PUT"]),
    Route("/api/artifacts/{artifact_id}", delete_artifact, methods=["DELETE"]),
    Route("/api/videos/{video_id}/status", get_video_status),
    Route("/api/videos/{video_id}", get_video),
    Route("/api/creators/{creator_id}/videos", list_creator_videos),
    Route("/frames/{frame_id}", get_frame),
]
