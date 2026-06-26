"""HTTP API for the agency UGC dashboard (src/canvas-ui/app/agency).

A separate operational surface from the canvas: a roster of UGC creators, each
with a queue of deliveries reviewed against a brief/reference, producing a
verdict + per-dimension scores + a Slack-ready coaching note. Scores persist on
reviews so improvement-over-time trends a creator across deliveries.

    GET    /api/agency/roster                      -> {roster:[...]}
    POST   /api/agency/creators                    -> add a talent creator
    GET    /api/agency/creators/{creator_id}       -> {creator, reviews:[...]}
    POST   /api/agency/deliveries                  -> ingest a delivery (URL or upload)
                                                      + brief/reference -> start review
    GET    /api/agency/reviews/{review_id}         -> {review, delivery, reference}
    POST   /api/agency/reviews/{review_id}/run     -> (re)generate the review now
    DELETE /api/agency/reviews/{review_id}         -> soft-delete a review

Ingestion is upload-first (the agency has the file): the delivery POST accepts a
base64 `file_data` (saved locally, analysed in place — sidesteps the IG/TikTok
yt-dlp login wall, D42) OR a `source_url` for the url path.
"""

from __future__ import annotations

import base64
import uuid
from pathlib import Path

from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

import db
import review_generate
import video_view
import worker

# Uploaded delivery files live here; the worker reads them via videos.local_path.
UPLOAD_DIR = Path(__file__).resolve().parent / "uploads"


def _decode_data_url(value) -> bytes | None:
    """Decode a `data:video/...;base64,XXXX` URL (or bare base64) to bytes."""
    if not isinstance(value, str) or not value:
        return None
    b64 = value.split(",", 1)[1] if value.startswith("data:") else value
    try:
        return base64.b64decode(b64)
    except Exception:
        return None


def _full_video_view(video_id: str | None) -> dict | None:
    """The full derived view-model for a video (hook/tone/pacing/scenes/status)."""
    if not video_id:
        return None
    full = db.get_video_full(video_id)
    if full is None:
        return None
    return video_view.derive_video(full["video"], full["shots"])


# ── handlers ─────────────────────────────────────────────────────────────────


async def roster(_: Request) -> JSONResponse:
    data = await run_in_threadpool(db.agency_roster)
    return JSONResponse({"roster": data})


async def add_creator(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "invalid JSON"}, status_code=400)
    name = (body.get("name") or "").strip()
    if not name:
        return JSONResponse({"error": "name is required"}, status_code=400)
    result = await run_in_threadpool(
        lambda: db.create_talent_creator(name, body.get("platform"))
    )
    return JSONResponse(result, status_code=201)


async def creator_detail(request: Request) -> JSONResponse:
    cid = request.path_params["creator_id"]
    creator = await run_in_threadpool(db.get_creator, cid)
    if creator is None:
        return JSONResponse({"error": "creator not found"}, status_code=404)
    reviews = await run_in_threadpool(db.list_reviews_for_creator, cid)
    return JSONResponse({"creator": creator, "reviews": reviews})


async def create_delivery(request: Request) -> JSONResponse:
    """Ingest a delivery and start its review. Body:
      creator_id | creator_name : roster creator (existing or new talent)
      source_url                : url ingestion (best-effort for walled platforms)
      file_name + file_data     : upload ingestion (base64/data-url, preferred)
      brief_title, brief        : the written brief (optional)
      reference_url             : a reference video to match against (optional)
    """
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "invalid JSON"}, status_code=400)

    # Resolve the roster creator.
    creator_id = body.get("creator_id")
    creator_name = (body.get("creator_name") or "").strip()
    if creator_id:
        creator = await run_in_threadpool(db.get_creator, creator_id)
        if creator is None:
            return JSONResponse({"error": "creator not found"}, status_code=404)
    elif creator_name:
        created = await run_in_threadpool(db.create_talent_creator, creator_name)
        creator_id = created["creator_id"]
    else:
        return JSONResponse(
            {"error": "creator_id or creator_name is required"}, status_code=400
        )

    # Resolve the source: an uploaded file, or a URL.
    local_path: str | None = None
    title: str | None = None
    file_data = _decode_data_url(body.get("file_data"))
    if file_data is not None:
        try:
            UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
            token = uuid.uuid4().hex
            file_name = (body.get("file_name") or "delivery.mp4").strip()
            ext = Path(file_name).suffix or ".mp4"
            dest = UPLOAD_DIR / f"{token}{ext}"
            dest.write_bytes(file_data)
        except Exception:
            return JSONResponse({"error": "could not save upload"}, status_code=400)
        local_path = str(dest)
        title = file_name
        source_url = f"upload://{token}/{file_name}"
    else:
        source_url = (body.get("source_url") or "").strip()
        if not source_url:
            return JSONResponse(
                {"error": "source_url or file_data is required"}, status_code=400
            )

    try:
        delivery_video_id = await run_in_threadpool(
            db.create_delivery_video, creator_id, source_url, local_path, title
        )
        await run_in_threadpool(worker.spawn_analysis_worker, delivery_video_id)

        reference_video_id = None
        reference_url = (body.get("reference_url") or "").strip()
        if reference_url:
            ref_creator = await run_in_threadpool(db.find_or_create_references_creator)
            reference_video_id, ref_created = await run_in_threadpool(
                db.get_or_create_video, ref_creator, reference_url
            )
            if ref_created:
                await run_in_threadpool(worker.spawn_analysis_worker, reference_video_id)

        review_id = await run_in_threadpool(
            db.create_review,
            creator_id,
            delivery_video_id,
            reference_video_id,
            body.get("brief_title"),
            body.get("brief"),
        )
    except Exception:
        return JSONResponse({"error": "could not start delivery"}, status_code=400)

    review_generate.spawn_review_watcher(review_id, delivery_video_id, reference_video_id)
    return JSONResponse(
        {
            "review_id": review_id,
            "video_id": delivery_video_id,
            "creator_id": creator_id,
        },
        status_code=201,
    )


async def get_review(request: Request) -> JSONResponse:
    rid = request.path_params["review_id"]
    review = await run_in_threadpool(db.get_review, rid)
    if review is None:
        return JSONResponse({"error": "review not found"}, status_code=404)
    delivery = await run_in_threadpool(_full_video_view, review["delivery_video_id"])
    reference = await run_in_threadpool(_full_video_view, review.get("reference_video_id"))
    creator = await run_in_threadpool(db.get_creator, review["creator_id"])
    return JSONResponse(
        {"review": review, "delivery": delivery, "reference": reference, "creator": creator}
    )


async def run_review(request: Request) -> JSONResponse:
    """(Re)generate a review now — e.g. after the delivery finished analysing, or
    to re-coach with the same inputs. Returns immediately; poll GET for the result."""
    rid = request.path_params["review_id"]
    review = await run_in_threadpool(db.get_review, rid)
    if review is None:
        return JSONResponse({"error": "review not found"}, status_code=404)
    await run_in_threadpool(db.update_review, rid, status="analyzing", error=None)
    # Wait for analysis (if still running) then generate — same path as ingestion.
    review_generate.spawn_review_watcher(
        rid, review["delivery_video_id"], review.get("reference_video_id")
    )
    return JSONResponse({"review_id": rid, "status": "analyzing"})


async def delete_review(request: Request) -> JSONResponse:
    rid = request.path_params["review_id"]
    ok = await run_in_threadpool(db.delete_review, rid)
    if not ok:
        return JSONResponse({"error": "review not found"}, status_code=404)
    return JSONResponse({"ok": True})


routes = [
    Route("/api/agency/roster", roster),
    Route("/api/agency/creators", add_creator, methods=["POST"]),
    Route("/api/agency/creators/{creator_id}", creator_detail),
    Route("/api/agency/deliveries", create_delivery, methods=["POST"]),
    Route("/api/agency/reviews/{review_id}", get_review, methods=["GET", "HEAD"]),
    Route("/api/agency/reviews/{review_id}", delete_review, methods=["DELETE"]),
    Route("/api/agency/reviews/{review_id}/run", run_review, methods=["POST"]),
]
