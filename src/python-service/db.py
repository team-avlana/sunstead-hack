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
            kwargs={"row_factory": dict_row},
        )
    return _pool


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

def insert_video(creator_id: str, source_url: str) -> str:
    with get_conn() as conn:
        row = conn.execute(
            "INSERT INTO videos (creator_id, source_url) VALUES (%s, %s) RETURNING id",
            (creator_id, source_url),
        ).fetchone()
        return str(row["id"])


def get_video_analysis(video_id: str) -> dict | None:
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
            "SELECT idx, start_sec, end_sec FROM shots "
            "WHERE video_id = %s AND deleted_at IS NULL ORDER BY idx",
            (video_id,),
        ).fetchall()

    if row["analysis_error"]:
        status = "failed"
    elif row["analyzed_at"]:
        status = "done"
    else:
        status = "running"

    shots_summary = [
        {"idx": s["idx"], "start_sec": float(s["start_sec"]), "end_sec": float(s["end_sec"])}
        for s in shots
    ]

    return {
        "status": status,
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
