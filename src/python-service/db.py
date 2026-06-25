"""Postgres connection pool and CRUD helpers."""

import json
from contextlib import contextmanager
from typing import Any

import psycopg
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from config import settings

_pool: ConnectionPool | None = None


def get_pool() -> ConnectionPool:
    global _pool
    if _pool is None:
        _pool = ConnectionPool(
            settings.db.connection_string,
            min_size=1,
            max_size=5,
            open=True,  # explicit (implicit-open is deprecated in psycopg_pool 3.3)
            kwargs={"row_factory": dict_row},
        )
    return _pool


def close_pool() -> None:
    """Close the pool on shutdown (called from the server lifespan)."""
    global _pool
    if _pool is not None:
        _pool.close()
        _pool = None


@contextmanager
def get_conn():
    with get_pool().connection() as conn:
        yield conn


# ── Projects ─────────────────────────────────────────────────────────────────

def create_project(name: str) -> dict:
    with get_conn() as conn:
        row = conn.execute(
            "INSERT INTO projects (name) VALUES (%s) RETURNING id",
            (name,),
        ).fetchone()
        return {"project_id": str(row["id"])}


def list_projects() -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, name, created_at FROM projects WHERE deleted_at IS NULL ORDER BY created_at DESC"
        ).fetchall()
    return [
        {"project_id": str(r["id"]), "name": r["name"], "created_at": r["created_at"].isoformat()}
        for r in rows
    ]


# ── Creators ──────────────────────────────────────────────────────────────────

def get_creator_frames_for_room(creator_id: str, limit: int = 3) -> list[dict]:
    """Return up to `limit` talking-head frame rows for a creator's analyzed videos.

    Prefers frames where the shot analysis marks is_talking_head = true.
    Falls back to any frame if no talking-head shots exist.
    Returns [{data: bytes, mime_type: str, analysis: dict}].
    """
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT f.data, f.mime_type, s.analysis
               FROM frames f
               JOIN shots s ON f.shot_id = s.id
               JOIN videos v ON s.video_id = v.id
               WHERE v.creator_id = %s
                 AND v.deleted_at IS NULL
                 AND s.deleted_at IS NULL
                 AND v.analyzed_at IS NOT NULL
                 AND COALESCE(s.analysis->'llm'->>'is_talking_head',
                              s.analysis->>'is_talking_head') = 'true'
               ORDER BY RANDOM()
               LIMIT %s""",
            (creator_id, limit),
        ).fetchall()

        if not rows:
            rows = conn.execute(
                """SELECT f.data, f.mime_type, s.analysis
                   FROM frames f
                   JOIN shots s ON f.shot_id = s.id
                   JOIN videos v ON s.video_id = v.id
                   WHERE v.creator_id = %s
                     AND v.deleted_at IS NULL
                     AND s.deleted_at IS NULL
                     AND v.analyzed_at IS NOT NULL
                   ORDER BY RANDOM()
                   LIMIT %s""",
                (creator_id, limit),
            ).fetchall()

    return [
        {
            "data": bytes(r["data"]),
            "mime_type": r["mime_type"],
            "analysis": r["analysis"] or {},
        }
        for r in rows
    ]


def save_creator_room_image(creator_id: str, data: bytes, mime_type: str = "image/png") -> None:
    """Persist a generated room image onto the creators row."""
    with get_conn() as conn:
        conn.execute(
            "UPDATE creators SET room_image = %s, room_image_mime = %s "
            "WHERE id = %s AND deleted_at IS NULL",
            (data, mime_type, creator_id),
        )


def get_creator_room_image(creator_id: str) -> dict | None:
    """Return {data: bytes, mime_type: str} or None if no image has been generated."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT room_image, room_image_mime FROM creators "
            "WHERE id = %s AND deleted_at IS NULL",
            (creator_id,),
        ).fetchone()
    if not row or row["room_image"] is None:
        return None
    return {"data": bytes(row["room_image"]), "mime_type": row["room_image_mime"]}


def find_or_create_creator(kind: str, name: str, channel_url: str | None = None) -> dict:
    with get_conn() as conn:
        if channel_url:
            row = conn.execute(
                "SELECT id FROM creators WHERE channel_url = %s AND deleted_at IS NULL",
                (channel_url,),
            ).fetchone()
        else:
            row = None

        if row:
            return {"creator_id": str(row["id"]), "created": False}

        row = conn.execute(
            "INSERT INTO creators (kind, name, channel_url) VALUES (%s, %s, %s) RETURNING id",
            (kind, name, channel_url),
        ).fetchone()
        return {"creator_id": str(row["id"]), "created": True}


def list_creators(kind: str | None = None) -> list[dict]:
    with get_conn() as conn:
        if kind:
            rows = conn.execute(
                "SELECT id, kind, name, platform, channel_url, created_at FROM creators "
                "WHERE deleted_at IS NULL AND kind = %s ORDER BY name",
                (kind,),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT id, kind, name, platform, channel_url, created_at FROM creators "
                "WHERE deleted_at IS NULL ORDER BY name"
            ).fetchall()
    return [
        {
            "creator_id": str(r["id"]),
            "kind": r["kind"],
            "name": r["name"],
            "platform": r["platform"],
            "channel_url": r["channel_url"],
            "created_at": r["created_at"].isoformat(),
        }
        for r in rows
    ]


def get_style_profile(creator_id: str) -> dict | None:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT summary, profile FROM style_profiles "
            "WHERE creator_id = %s AND deleted_at IS NULL "
            "ORDER BY created_at DESC LIMIT 1",
            (creator_id,),
        ).fetchone()
    if not row:
        return None
    return {"summary": row["summary"], "profile": row["profile"]}


# ── Videos ───────────────────────────────────────────────────────────────────

def find_or_create_video(creator_id: str, source_url: str) -> tuple[str, bool]:
    """Returns (video_id, created). created=False means the row already existed."""
    with get_conn() as conn:
        row = conn.execute(
            "INSERT INTO videos (creator_id, source_url) VALUES (%s, %s) "
            "ON CONFLICT (creator_id, source_url) WHERE deleted_at IS NULL "
            "DO NOTHING RETURNING id",
            (creator_id, source_url),
        ).fetchone()
        if row:
            return str(row["id"]), True
        row = conn.execute(
            "SELECT id FROM videos WHERE creator_id = %s AND source_url = %s AND deleted_at IS NULL",
            (creator_id, source_url),
        ).fetchone()
        return str(row["id"]), False


def get_video_analysis(video_id: str) -> dict | None:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT id, source_url, title, duration_sec, metrics, "
            "analyzed_at, analysis_error, analysis_stage, created_at "
            "FROM videos WHERE id = %s AND deleted_at IS NULL",
            (video_id,),
        ).fetchone()
        if not row:
            return None

        shots = conn.execute(
            """SELECT s.idx, s.start_sec, s.end_sec, f.id AS frame_id
               FROM shots s
               LEFT JOIN frames f ON f.shot_id = s.id
               WHERE s.video_id = %s AND s.deleted_at IS NULL
               ORDER BY s.idx""",
            (video_id,),
        ).fetchall()

    if row["analysis_error"]:
        status = "failed"
    elif row["analyzed_at"]:
        status = "done"
    else:
        status = "running"

    shots_summary = [
        {
            "idx": s["idx"],
            "start_sec": float(s["start_sec"]),
            "end_sec": float(s["end_sec"]),
            "frame_id": str(s["frame_id"]) if s["frame_id"] else None,
        }
        for s in shots
    ]

    return {
        "status": status,
        "analysis_stage": row["analysis_stage"],
        "video": {
            "video_id": str(row["id"]),
            "source_url": row["source_url"],
            "title": row["title"],
            "duration_sec": float(row["duration_sec"]) if row["duration_sec"] else None,
            "metrics": row["metrics"],
            "analyzed_at": row["analyzed_at"].isoformat() if row["analyzed_at"] else None,
            "analysis_error": row["analysis_error"],
        },
        "shots_summary": shots_summary,
    }


def get_channel_videos(creator_id: str) -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, analyzed_at, analysis_error FROM videos "
            "WHERE creator_id = %s AND deleted_at IS NULL",
            (creator_id,),
        ).fetchall()

    result = []
    for r in rows:
        if r["analysis_error"]:
            status = "failed"
        elif r["analyzed_at"]:
            status = "done"
        else:
            status = "running"
        result.append({"video_id": str(r["id"]), "status": status})
    return result


# ── Artifacts ─────────────────────────────────────────────────────────────────

def create_artifact(
    project_id: str,
    type_: str,
    title: str | None,
    payload: Any,
    position: Any = None,
) -> dict:
    with get_conn() as conn:
        row = conn.execute(
            "INSERT INTO artifacts (project_id, type, title, payload, position) "
            "VALUES (%s, %s, %s, %s, %s) RETURNING id, version",
            (project_id, type_, title, json.dumps(payload), json.dumps(position) if position else None),
        ).fetchone()
        return {"artifact_id": str(row["id"]), "version": row["version"], "project_id": project_id}


def update_artifact(
    artifact_id: str,
    payload: Any = None,
    element_id: str | None = None,
    element_patch: Any = None,
    position: Any = None,
    title: str | None = None,
) -> dict | None:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT id, project_id, payload FROM artifacts WHERE id = %s AND deleted_at IS NULL",
            (artifact_id,),
        ).fetchone()
        if not row:
            return None

        current_payload = row["payload"] or {}
        project_id = str(row["project_id"])

        if element_id is not None and element_patch is not None:
            # Addressed element update within payload
            if isinstance(current_payload, dict):
                elements = current_payload.get("elements", [])
                for i, el in enumerate(elements):
                    if isinstance(el, dict) and el.get("id") == element_id:
                        elements[i] = {**el, **element_patch}
                        break
                current_payload = {**current_payload, "elements": elements}
            new_payload = current_payload
        elif payload is not None:
            new_payload = payload
        else:
            new_payload = current_payload

        sets = ["payload = %s", "version = version + 1"]
        params: list = [json.dumps(new_payload)]

        if position is not None:
            sets.append("position = %s")
            params.append(json.dumps(position))
        if title is not None:
            sets.append("title = %s")
            params.append(title)

        params.append(artifact_id)
        updated = conn.execute(
            f"UPDATE artifacts SET {', '.join(sets)} WHERE id = %s RETURNING id, version, project_id",
            params,
        ).fetchone()

        return {
            "artifact_id": str(updated["id"]),
            "version": updated["version"],
            "project_id": str(updated["project_id"]),
        }


def get_artifact(artifact_id: str) -> dict | None:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT id, project_id, type, title, payload, position, z, version, created_at, updated_at "
            "FROM artifacts WHERE id = %s AND deleted_at IS NULL",
            (artifact_id,),
        ).fetchone()
    if not row:
        return None
    return _artifact_row(row)


def list_artifacts(project_id: str) -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, project_id, type, title, payload, position, z, version, created_at, updated_at "
            "FROM artifacts WHERE project_id = %s AND deleted_at IS NULL ORDER BY created_at",
            (project_id,),
        ).fetchall()
    return [_artifact_row(r) for r in rows]


def delete_artifact(artifact_id: str) -> dict | None:
    with get_conn() as conn:
        row = conn.execute(
            "UPDATE artifacts SET deleted_at = now() WHERE id = %s AND deleted_at IS NULL "
            "RETURNING id, project_id",
            (artifact_id,),
        ).fetchone()
    if not row:
        return None
    return {"ok": True, "artifact_id": str(row["id"]), "project_id": str(row["project_id"])}


def _artifact_row(row: dict) -> dict:
    return {
        "artifact_id": str(row["id"]),
        "project_id": str(row["project_id"]),
        "type": row["type"],
        "title": row["title"],
        "payload": row["payload"],
        "position": row["position"],
        "z": row["z"],
        "version": row["version"],
        "created_at": row["created_at"].isoformat(),
        "updated_at": row["updated_at"].isoformat(),
    }


# ── Memory ────────────────────────────────────────────────────────────────────

VALID_MEMORY_KINDS = {"goal", "audience", "platform", "constraint", "preference", "note"}


def save_memory(
    kind: str,
    value: str,
    key: str | None = None,
    data: Any = None,
    project_id: str | None = None,
) -> dict:
    with get_conn() as conn:
        row = conn.execute(
            "INSERT INTO memory (project_id, kind, key, value, data) "
            "VALUES (%s, %s, %s, %s, %s) RETURNING id",
            (project_id, kind, key, value, json.dumps(data) if data is not None else None),
        ).fetchone()
    return {"memory_id": str(row["id"])}


def list_memory(project_id: str | None = None, kind: str | None = None) -> list[dict]:
    with get_conn() as conn:
        conditions = ["deleted_at IS NULL"]
        params: list = []
        if project_id is not None:
            conditions.append("project_id = %s")
            params.append(project_id)
        else:
            conditions.append("project_id IS NULL")
        if kind:
            conditions.append("kind = %s")
            params.append(kind)

        rows = conn.execute(
            f"SELECT id, project_id, kind, key, value, data, created_at "
            f"FROM memory WHERE {' AND '.join(conditions)} ORDER BY created_at",
            params,
        ).fetchall()

    return [
        {
            "memory_id": str(r["id"]),
            "project_id": str(r["project_id"]) if r["project_id"] else None,
            "kind": r["kind"],
            "key": r["key"],
            "value": r["value"],
            "data": r["data"],
            "created_at": r["created_at"].isoformat(),
        }
        for r in rows
    ]


def delete_memory(memory_id: str) -> bool:
    with get_conn() as conn:
        row = conn.execute(
            "UPDATE memory SET deleted_at = now() WHERE id = %s AND deleted_at IS NULL RETURNING id",
            (memory_id,),
        ).fetchone()
    return row is not None


# ── Read helpers for the canvas HTTP API ───────────────────────────────────────

def get_project(project_id: str) -> dict | None:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT id, name, created_at, updated_at FROM projects "
            "WHERE id = %s AND deleted_at IS NULL",
            (project_id,),
        ).fetchone()
    if not row:
        return None
    return {
        "project_id": str(row["id"]),
        "name": row["name"],
        "created_at": row["created_at"].isoformat(),
        "updated_at": row["updated_at"].isoformat(),
    }


def get_video_full(video_id: str) -> dict | None:
    """A videos row (with metrics) plus all its shots — for the Video Block view."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT id, source_url, title, duration_sec, metrics, "
            "analyzed_at, analysis_error, created_at "
            "FROM videos WHERE id = %s AND deleted_at IS NULL",
            (video_id,),
        ).fetchone()
        if not row:
            return None
        shots = conn.execute(
            """SELECT s.idx, s.start_sec, s.end_sec, s.analysis,
                      f.id AS frame_id
               FROM shots s
               LEFT JOIN frames f ON f.shot_id = s.id
               WHERE s.video_id = %s AND s.deleted_at IS NULL
               ORDER BY s.idx""",
            (video_id,),
        ).fetchall()
    return {"video": dict(row), "shots": [dict(s) for s in shots]}


def get_frame(frame_id: str) -> dict | None:
    """Return the raw bytes and mime_type for a frame row."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT data, mime_type FROM frames WHERE id = %s",
            (frame_id,),
        ).fetchone()
    if not row:
        return None
    return {"data": bytes(row["data"]), "mime_type": row["mime_type"]}


def get_video_status(video_id: str) -> dict | None:
    """Lightweight status check — no shot join, suitable for polling."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT id, title, duration_sec, analyzed_at, analysis_error, analysis_stage "
            "FROM videos WHERE id = %s AND deleted_at IS NULL",
            (video_id,),
        ).fetchone()
    if not row:
        return None
    if row["analysis_error"]:
        status = "error"
    elif row["analyzed_at"]:
        status = "analysed"
    else:
        status = "analysing"
    return {
        "video_id": str(row["id"]),
        "status": status,
        "analysis_stage": row["analysis_stage"],
        "title": row["title"],
        "duration_sec": float(row["duration_sec"]) if row["duration_sec"] else None,
        "analyzed_at": row["analyzed_at"].isoformat() if row["analyzed_at"] else None,
        "analysis_error": row["analysis_error"],
    }


def get_creator_videos(creator_id: str) -> list[dict] | None:
    """All videos for a creator with status + display metadata.

    Returns None if the creator doesn't exist (vs. [] for a creator with no videos).
    """
    with get_conn() as conn:
        creator = conn.execute(
            "SELECT 1 FROM creators WHERE id = %s AND deleted_at IS NULL",
            (creator_id,),
        ).fetchone()
        if not creator:
            return None
        rows = conn.execute(
            """SELECT v.id, v.title, v.source_url, v.duration_sec,
                      v.analyzed_at, v.analysis_error,
                      (SELECT f.id FROM frames f
                       JOIN shots s ON f.shot_id = s.id
                       WHERE s.video_id = v.id AND s.deleted_at IS NULL
                       ORDER BY s.idx LIMIT 1) AS frame_id
               FROM videos v
               WHERE v.creator_id = %s AND v.deleted_at IS NULL
               ORDER BY v.created_at DESC""",
            (creator_id,),
        ).fetchall()

    result = []
    for r in rows:
        if r["analysis_error"]:
            status = "error"
        elif r["analyzed_at"]:
            status = "analysed"
        else:
            status = "analysing"
        frame_id = str(r["frame_id"]) if r["frame_id"] else None
        result.append({
            "video_id": str(r["id"]),
            "status": status,
            "title": r["title"],
            "source_url": r["source_url"],
            "duration_sec": float(r["duration_sec"]) if r["duration_sec"] else None,
            "thumbnail": f"/frames/{frame_id}" if frame_id else None,
        })
    return result


def project_ids_for_video(video_id: str) -> list[str]:
    """Projects whose live artifacts reference this video (payload.video_id)."""
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT DISTINCT project_id FROM artifacts "
            "WHERE deleted_at IS NULL AND payload->>'video_id' = %s",
            (video_id,),
        ).fetchall()
    return [str(r["project_id"]) for r in rows]


def pg_notify_change(payload: dict) -> None:
    """Emit a Postgres NOTIFY on 'rainy_change'. The server's listener forwards it
    to websocket subscribers. Used for cross-process signals (e.g. analyze_video)."""
    with get_conn() as conn:
        conn.execute("SELECT pg_notify('rainy_change', %s)", (json.dumps(payload),))
