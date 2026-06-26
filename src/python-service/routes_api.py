"""HTTP API for the canvas-ui (a static export that cannot open Postgres directly).
Mounted alongside the MCP server in server.py.

    GET    /api/health
    GET    /api/projects
    GET    /api/projects/{project_id}        -> {project, artifacts:[enriched]}
    POST   /api/projects/{project_id}/artifacts -> create; broadcasts WS change signal
    GET    /api/artifacts/{artifact_id}      -> enriched artifact
    PUT    /api/artifacts/{artifact_id}      -> update; broadcasts WS change signal
    DELETE /api/artifacts/{artifact_id}      -> soft-delete; broadcasts WS change signal
    POST   /api/artifacts/{artifact_id}/restore -> undo soft-delete; broadcasts WS change signal
    POST   /api/analyze                      -> start analysis for a URL -> {video_id}
    GET    /api/videos/{video_id}            -> {video, shots_summary}
    GET    /api/videos/{video_id}/status     -> lightweight status poll
    POST   /api/videos/{video_id}/reanalyze  -> re-run analysis for a video
    GET    /api/creators/{creator_id}/videos -> video list with status + metadata
    GET    /frames/{frame_id}               -> JPEG image served from the frames table

"Enriched" = a `type:'video'` artifact gets a live `video` view-model attached,
joined from the videos table via payload.video_id (see video_view.derive_video).
"""

from __future__ import annotations

import base64

from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

import active_project
import db
import dev_events
import notify
import video_view
from tools.analysis import start_channel_analysis

# Image generation is an optional feature (needs `openai` + Azure config). A
# missing dependency here must never take down the whole API at import time, so
# load it defensively — the room-image route degrades to 503 if it's unavailable.
try:
    import image_gen
except Exception as exc:  # pragma: no cover - depends on optional deps/config
    image_gen = None
    _IMAGE_GEN_IMPORT_ERROR = repr(exc)
else:
    _IMAGE_GEN_IMPORT_ERROR = None
import worker


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
        return {
            "video_id": video_id,
            "status": "not_analysed",
            "tags": [],
            "storyboard": [],
        }
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
        {
            "idx": s["idx"],
            "start_sec": float(s["start_sec"]),
            "end_sec": float(s["end_sec"]),
        }
        for s in full["shots"]
    ]
    return JSONResponse({"video": view, "shots_summary": shots_summary})


async def create_artifact(request: Request) -> JSONResponse:
    """Create an artifact for a project (the canvas authoring a new block/flow).
    Mirrors the MCP create_artifact tool so canvas-originated and agent-originated
    creates land identically and both ping the websocket."""
    pid = request.path_params["project_id"]
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "invalid JSON"}, status_code=400)

    type_ = body.get("type") or "frame"
    try:
        result = await run_in_threadpool(
            lambda: db.create_artifact(
                project_id=pid,
                type_=type_,
                title=body.get("title"),
                payload=body.get("payload") or {},
                position=body.get("position"),
                client_id=body.get("client_id"),
            )
        )
    except Exception:
        # Most likely an unknown project_id (FK violation). Don't echo the DB error.
        return JSONResponse({"error": "could not create artifact"}, status_code=400)

    await notify.broadcast(
        {
            "type": "artifact",
            "action": "created",
            "artifact_id": result["artifact_id"],
            "project_id": pid,
            "version": result["version"],
        },
        project_id=pid,
    )
    return JSONResponse(
        {"artifact_id": result["artifact_id"], "version": result["version"]}
    )


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
            element_remove=body.get("element_remove"),
            payload_patch=body.get("payload_patch"),
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


async def restore_artifact(request: Request) -> JSONResponse:
    """Undo a delete: clear the soft-delete so the same artifact id comes back.
    Idempotent; broadcasts the same change signal so every client re-pulls it."""
    aid = request.path_params["artifact_id"]
    result = await run_in_threadpool(db.restore_artifact, aid)
    if result is None:
        return JSONResponse({"error": "artifact not found"}, status_code=404)

    await notify.broadcast(
        {
            "type": "artifact",
            "action": "restored",
            "artifact_id": aid,
            "project_id": result["project_id"],
            "version": result["version"],
        },
        project_id=result["project_id"],
    )
    return JSONResponse({"artifact_id": aid, "version": result["version"]})


async def get_video_status(request: Request) -> JSONResponse:
    vid = request.path_params["video_id"]
    status = await run_in_threadpool(db.get_video_status, vid)
    if status is None:
        return JSONResponse({"error": "video not found"}, status_code=404)
    return JSONResponse(status)


async def analyze(request: Request) -> JSONResponse:
    """Start analysis for a video URL — the canvas equivalent of the analyze_video
    MCP tool (Video Block "Analyse" button / sidebar). Inserts a videos row, spawns
    the analysis-worker, and returns the new video_id; the block then polls
    /api/videos/{video_id} until status flips to analysed/error.

    Body: {source_url, creator_id?}. Without creator_id, a singleton "Canvas"
    creator owns the video (see db.find_or_create_default_creator)."""
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "invalid JSON"}, status_code=400)

    source_url = (body.get("source_url") or "").strip()
    if not source_url:
        return JSONResponse({"error": "source_url is required"}, status_code=400)

    creator_id = body.get("creator_id")
    try:
        if not creator_id:
            creator_id = await run_in_threadpool(db.find_or_create_default_creator)
        # Reuse the existing video when the same URL is analysed again (the worker
        # re-runs idempotently), so a repeat analyse doesn't hit the unique index.
        video_id, _created = await run_in_threadpool(
            db.get_or_create_video, creator_id, source_url
        )
    except Exception:
        # Don't echo the DB error (it can carry the DSN/credentials).
        return JSONResponse({"error": "could not start analysis"}, status_code=400)

    await run_in_threadpool(worker.spawn_analysis_worker, video_id)
    # Signal any all-projects listeners; the canvas block also polls the status API.
    await run_in_threadpool(
        db.pg_notify_change,
        {"type": "video", "action": "created", "video_id": video_id},
    )
    return JSONResponse({"video_id": video_id, "creator_id": creator_id})


async def reanalyze(request: Request) -> JSONResponse:
    """Re-run analysis for an existing video (Video Block "Retry" button). The
    worker is idempotent — it clears the prior error and replaces shots/frames."""
    vid = request.path_params["video_id"]
    status = await run_in_threadpool(db.get_video_status, vid)
    if status is None:
        return JSONResponse({"error": "video not found"}, status_code=404)
    await run_in_threadpool(worker.spawn_analysis_worker, vid)
    await run_in_threadpool(
        db.pg_notify_change, {"type": "video", "action": "reanalyze", "video_id": vid}
    )
    return JSONResponse({"video_id": vid, "status": "analysing"})


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


async def get_storyboard_frame(request: Request):
    frame_id = request.path_params["frame_id"]
    frame = await run_in_threadpool(db.get_storyboard_frame, frame_id)
    if frame is None:
        return JSONResponse({"error": "storyboard frame not found"}, status_code=404)
    return Response(content=frame["data"], media_type=frame["mime_type"])


async def get_active_project(_: Request) -> JSONResponse:
    """The project the canvas currently has open (mirrors the MCP tool)."""
    return JSONResponse(active_project.get_active())


async def set_active_project(request: Request) -> JSONResponse:
    """The canvas reports the open project here on navigation; the embedded
    Claude session reads it back via the get_active_project MCP tool."""
    try:
        body = await request.json()
    except Exception:
        body = {}
    project_id = body.get("project_id")
    active_project.set_active(project_id, body.get("name"))
    return JSONResponse({"ok": True, "project_id": active_project.get_active_id()})


async def list_creators(request: Request) -> JSONResponse:
    kind = request.query_params.get("kind")
    if kind and kind not in ("self", "reference"):
        return JSONResponse(
            {"error": "kind must be 'self' or 'reference'"}, status_code=400
        )
    creators = await run_in_threadpool(db.list_creators, kind)
    return JSONResponse({"creators": creators})


async def get_creator_room_image(request: Request):
    cid = request.path_params["creator_id"]
    img = await run_in_threadpool(db.get_creator_room_image, cid)
    if img is None:
        return JSONResponse(
            {"error": "no room image for this creator"}, status_code=404
        )
    return Response(content=img["data"], media_type=img["mime_type"])


async def post_creator_room_image(request: Request) -> JSONResponse:
    """Trigger room image generation for a creator, save to DB, return the URL."""
    cid = request.path_params["creator_id"]

    if image_gen is None:
        return JSONResponse(
            {"error": f"image generation unavailable: {_IMAGE_GEN_IMPORT_ERROR}"},
            status_code=503,
        )

    # Optional inputs from the canvas wizard: a ready-made `prompt`, a structured
    # `profile` (fallback when no prompt), and an uploaded avatar photo (data: URL)
    # that anchors the clay character's likeness.
    profile: dict | None = None
    avatar_photo: bytes | None = None
    prompt: str | None = None
    try:
        body = await request.json()
        if isinstance(body, dict):
            profile = body.get("profile")
            prompt = body.get("prompt") or None
            avatar_photo = _decode_data_url(body.get("avatar_photo"))
    except Exception:
        pass  # body is optional — proceed without

    try:
        with dev_events.track("image", "generate room image", detail=cid):
            png_bytes = await run_in_threadpool(
                lambda: image_gen.generate(cid, profile, avatar_photo, prompt)
            )
    except RuntimeError as exc:
        return JSONResponse({"error": str(exc)}, status_code=503)
    except Exception as exc:
        return JSONResponse({"error": f"generation failed: {exc}"}, status_code=500)

    await run_in_threadpool(db.save_creator_room_image, cid, png_bytes, "image/png")
    return JSONResponse(
        {"creator_id": cid, "image_url": f"/api/creators/{cid}/room-image"},
        status_code=201,
    )


def _decode_data_url(value) -> bytes | None:
    """Decode a `data:image/...;base64,XXXX` URL (or bare base64) to bytes.
    Returns None for empty/invalid input so the caller proceeds without it."""
    if not isinstance(value, str) or not value:
        return None
    b64 = value.split(",", 1)[1] if value.startswith("data:") else value
    try:
        return base64.b64decode(b64)
    except Exception:
        return None


async def get_self_creator(_: Request) -> JSONResponse:
    """The single kind='self' creator (the user), created on first access. Carries
    cheap status flags so the home screen can show room/profile/analysis state
    without loading image bytes."""
    creator = await run_in_threadpool(db.get_or_create_self_creator)
    overview = await run_in_threadpool(db.creator_overview, creator["creator_id"])
    return JSONResponse({**creator, **(overview or {})})


async def get_style_profile(request: Request) -> JSONResponse:
    """Latest aggregated style profile for a creator (build via the POST below)."""
    cid = request.path_params["creator_id"]
    result = await run_in_threadpool(db.get_style_profile, cid)
    if result is None:
        return JSONResponse(
            {"error": "no style profile for this creator"}, status_code=404
        )
    return JSONResponse(result)


async def build_style_profile(request: Request) -> JSONResponse:
    """Trigger style-profile aggregation (background) — mirrors the MCP tool. Poll
    GET .../style-profile and watch created_at advance to detect completion."""
    cid = request.path_params["creator_id"]
    creators = await run_in_threadpool(db.list_creators)
    if not any(c["creator_id"] == cid for c in creators):
        return JSONResponse({"error": "creator not found"}, status_code=404)
    await run_in_threadpool(worker.spawn_profile_builder, cid)
    return JSONResponse({"creator_id": cid, "status": "started"}, status_code=202)


async def analyze_channel(request: Request) -> JSONResponse:
    """Enumerate a channel and start analysis for each video (canvas onboarding /
    reference ingest). Body: {channel_url, kind, name?, max_videos?}."""
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "invalid JSON"}, status_code=400)

    channel_url = (body.get("channel_url") or "").strip()
    kind = body.get("kind")
    if not channel_url:
        return JSONResponse({"error": "channel_url is required"}, status_code=400)
    if kind not in ("self", "reference"):
        return JSONResponse(
            {"error": "kind must be 'self' or 'reference'"}, status_code=400
        )

    try:
        result = await run_in_threadpool(
            lambda: start_channel_analysis(
                channel_url, kind, body.get("name"), body.get("max_videos")
            )
        )
    except (ValueError, RuntimeError) as exc:
        # Validation / yt-dlp enumeration failures carry a useful message (no secrets).
        return JSONResponse({"error": str(exc)}, status_code=400)
    except Exception:
        return JSONResponse({"error": "could not analyze channel"}, status_code=400)
    return JSONResponse(result, status_code=202)


async def get_channel_analysis(request: Request) -> JSONResponse:
    """Progress for all videos belonging to a creator: {videos, done, total}."""
    cid = request.path_params["creator_id"]
    videos = await run_in_threadpool(db.get_channel_videos, cid)
    done = sum(1 for v in videos if v["status"] == "done")
    return JSONResponse(
        {"creator_id": cid, "videos": videos, "done": done, "total": len(videos)}
    )


async def get_video_shots(request: Request) -> JSONResponse:
    """Full shot list with per-shot analysis — the deep-dive behind a video block."""
    vid = request.path_params["video_id"]
    full = await run_in_threadpool(db.get_video_full, vid)
    if full is None:
        return JSONResponse({"error": "video not found"}, status_code=404)
    view = video_view.derive_video(full["video"], full["shots"])
    metrics = video_view.metrics_summary(full["video"])
    shots = [
        {
            "idx": s["idx"],
            "start_sec": float(s["start_sec"]),
            "end_sec": float(s["end_sec"]),
            "frame_id": str(s["frame_id"]) if s.get("frame_id") else None,
            "frame_url": f"/frames/{s['frame_id']}" if s.get("frame_id") else None,
            "analysis": s.get("analysis"),
        }
        for s in full["shots"]
    ]
    return JSONResponse(
        {
            "video_id": vid,
            "shot_count": len(shots),
            "shots": shots,
            "video": view,
            "metrics": metrics,
        }
    )


async def list_memory(request: Request) -> JSONResponse:
    """Memory for the canvas memory panel. Always returns user-level entries
    (project_id IS NULL); with ?project_id=X also returns that project's entries.
    Project rows come first. Optional ?kind= filter."""
    pid = request.query_params.get("project_id")
    kind = request.query_params.get("kind")
    user = await run_in_threadpool(lambda: db.list_memory(project_id=None, kind=kind))
    proj: list = []
    if pid:
        proj = await run_in_threadpool(lambda: db.list_memory(project_id=pid, kind=kind))
    return JSONResponse({"memory": proj + user})


async def create_memory(request: Request) -> JSONResponse:
    """Persist a memory entry (canvas memory panel). Body:
    {kind, value, key?, data?, project_id?}."""
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "invalid JSON"}, status_code=400)

    kind = body.get("kind")
    value = (body.get("value") or "").strip()
    if kind not in db.VALID_MEMORY_KINDS:
        return JSONResponse(
            {"error": f"kind must be one of: {', '.join(sorted(db.VALID_MEMORY_KINDS))}"},
            status_code=400,
        )
    if not value:
        return JSONResponse({"error": "value is required"}, status_code=400)

    result = await run_in_threadpool(
        lambda: db.save_memory(
            kind=kind,
            value=value,
            key=body.get("key"),
            data=body.get("data"),
            project_id=body.get("project_id"),
        )
    )
    return JSONResponse(result, status_code=201)


async def delete_memory(request: Request) -> JSONResponse:
    mid = request.path_params["memory_id"]
    ok = await run_in_threadpool(db.delete_memory, mid)
    if not ok:
        return JSONResponse({"error": "memory not found"}, status_code=404)
    return JSONResponse({"ok": True})


routes = [
    Route("/api/health", health),
    Route("/api/projects", list_projects),
    Route("/api/active-project", get_active_project, methods=["GET", "HEAD"]),
    Route("/api/active-project", set_active_project, methods=["PUT"]),
    Route("/api/projects/{project_id}", get_project),
    Route("/api/projects/{project_id}/artifacts", create_artifact, methods=["POST"]),
    Route("/api/artifacts/{artifact_id}", get_artifact, methods=["GET", "HEAD"]),
    Route("/api/artifacts/{artifact_id}", update_artifact, methods=["PUT"]),
    Route("/api/artifacts/{artifact_id}", delete_artifact, methods=["DELETE"]),
    Route("/api/artifacts/{artifact_id}/restore", restore_artifact, methods=["POST"]),
    Route("/api/analyze", analyze, methods=["POST"]),
    Route("/api/analyze-channel", analyze_channel, methods=["POST"]),
    Route("/api/videos/{video_id}/status", get_video_status),
    Route("/api/videos/{video_id}/reanalyze", reanalyze, methods=["POST"]),
    Route("/api/videos/{video_id}/shots", get_video_shots),
    Route("/api/videos/{video_id}", get_video),
    Route("/api/storyboard/{frame_id}", get_storyboard_frame),
    Route("/api/memory", list_memory, methods=["GET"]),
    Route("/api/memory", create_memory, methods=["POST"]),
    Route("/api/memory/{memory_id}", delete_memory, methods=["DELETE"]),
    Route("/api/creators", list_creators),
    # Literal /self before the {creator_id} patterns so it isn't shadowed.
    Route("/api/creators/self", get_self_creator),
    Route("/api/creators/{creator_id}/videos", list_creator_videos),
    Route("/api/creators/{creator_id}/channel-analysis", get_channel_analysis),
    Route(
        "/api/creators/{creator_id}/style-profile",
        get_style_profile,
        methods=["GET"],
    ),
    Route(
        "/api/creators/{creator_id}/style-profile",
        build_style_profile,
        methods=["POST"],
    ),
    Route(
        "/api/creators/{creator_id}/room-image", get_creator_room_image, methods=["GET"]
    ),
    Route(
        "/api/creators/{creator_id}/room-image",
        post_creator_room_image,
        methods=["POST"],
    ),
    Route("/frames/{frame_id}", get_frame),
]
