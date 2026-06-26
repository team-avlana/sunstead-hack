import json
import sys
from contextlib import contextmanager
from decimal import Decimal

import psycopg
from psycopg.rows import dict_row
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_fixed,
    before_sleep_log,
)
import logging

_log = logging.getLogger(__name__)


def _dumps(obj) -> str:
    """json.dumps that coerces Decimal (psycopg numeric) to float."""
    return json.dumps(
        obj, default=lambda o: float(o) if isinstance(o, Decimal) else str(o)
    )


@retry(
    retry=retry_if_exception_type(psycopg.OperationalError),
    stop=stop_after_attempt(3),  # 1 initial + 2 retries
    wait=wait_fixed(30),
    before_sleep=before_sleep_log(_log, logging.WARNING),
    reraise=True,
)
def _open_connection(dsn: str):
    return psycopg.connect(dsn, row_factory=dict_row)


@contextmanager
def connect(dsn: str):
    """Short-lived connection context manager with retry on OperationalError.

    Retries the connect() call up to 3 times with a 30-second wait between
    attempts, which covers transient 'too many connections' rejections.
    Commits on clean exit, rolls back and re-raises on exception, always closes.
    """
    conn = _open_connection(dsn)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def load_video(conn, video_id: str) -> dict:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, source_url, title, duration_sec, local_path, metrics "
            "FROM videos WHERE id = %s",
            (video_id,),
        )
        row = cur.fetchone()
    if row is None:
        raise ValueError(f"No video row found for id={video_id}")
    return dict(row)


def update_video_download_meta(
    conn,
    video_id: str,
    local_path: str,
    title: str,
    duration_sec: float,
    published_at,
    resolution: str,
    fps: float,
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE videos SET local_path=%s, title=%s, duration_sec=%s, published_at=%s "
            "WHERE id=%s",
            (local_path, title, duration_sec, published_at, video_id),
        )
    conn.commit()


def clear_analysis_error(conn, video_id: str) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE videos SET analysis_error=NULL, analysis_stage=NULL WHERE id=%s",
            (video_id,),
        )
    conn.commit()


def set_analysis_stage(conn, video_id: str, stage: str) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE videos SET analysis_stage=%s WHERE id=%s", (stage, video_id)
        )
    conn.commit()
    # Push the stage change so the canvas updates live over the websocket instead
    # of polling GET /api/videos/{id} every couple of seconds (notify.py forwards
    # this to video-scoped + project subscribers). Best-effort.
    notify_change(conn, video_id, "stage", stage)


def delete_existing_shots(conn, video_id: str) -> None:
    with conn.cursor() as cur:
        cur.execute("DELETE FROM shots WHERE video_id=%s", (video_id,))
    conn.commit()


def insert_shot(
    conn,
    video_id: str,
    idx: int,
    start_sec: float,
    end_sec: float,
    analysis: dict,
) -> str:
    """Insert (or upsert) a shot row. Returns the shot UUID."""
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO shots (video_id, idx, start_sec, end_sec, analysis)
               VALUES (%s, %s, %s, %s, %s)
               ON CONFLICT (video_id, idx) DO UPDATE SET
                 start_sec = EXCLUDED.start_sec,
                 end_sec   = EXCLUDED.end_sec,
                 analysis  = EXCLUDED.analysis
               RETURNING id""",
            (video_id, idx, start_sec, end_sec, _dumps(analysis)),
        )
        row = cur.fetchone()
    return str(row["id"])


def insert_frame(
    conn,
    shot_id: str,
    video_id: str,
    timestamp_sec: float,
    data: bytes,
    width: int | None = None,
    height: int | None = None,
) -> str:
    """Insert a frame row. Returns the frame UUID."""
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO frames (shot_id, video_id, timestamp_sec, data, width, height)
               VALUES (%s, %s, %s, %s, %s, %s)
               RETURNING id""",
            (shot_id, video_id, timestamp_sec, data, width, height),
        )
        row = cur.fetchone()
    return str(row["id"])


def write_video_metrics(conn, video_id: str, metrics: dict) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE videos SET metrics=%s WHERE id=%s",
            (_dumps(metrics), video_id),
        )


def set_analyzed_at(conn, video_id: str) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE videos SET analyzed_at=now(), analysis_stage=NULL WHERE id=%s",
            (video_id,),
        )
    conn.commit()


def set_analysis_error(conn, video_id: str, error: str) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE videos SET analysis_error=%s, analysis_stage=NULL WHERE id=%s",
            (error[:2000], video_id),
        )
    conn.commit()


def load_creator(conn, creator_id: str) -> dict:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, name, platform, channel_url, kind FROM creators WHERE id = %s",
            (creator_id,),
        )
        row = cur.fetchone()
    if row is None:
        raise ValueError(f"No creator row found for id={creator_id}")
    return dict(row)


def load_completed_videos(conn, creator_id: str) -> list[dict]:
    """Return all analyzed (not failed, not deleted) videos for this creator."""
    with conn.cursor() as cur:
        cur.execute(
            """SELECT id, title, duration_sec, source_url, published_at, metrics
               FROM videos
               WHERE creator_id = %s
                 AND analyzed_at IS NOT NULL
                 AND analysis_error IS NULL
                 AND deleted_at IS NULL
               ORDER BY published_at ASC NULLS LAST, created_at ASC""",
            (creator_id,),
        )
        rows = cur.fetchall()
    return [dict(r) for r in rows]


def insert_style_profile(conn, creator_id: str, summary: str, profile: dict) -> str:
    """Insert a new versioned style_profiles row. Returns the new row's id."""
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO style_profiles (creator_id, summary, profile)
               VALUES (%s, %s, %s)
               RETURNING id""",
            (creator_id, summary, _dumps(profile)),
        )
        row = cur.fetchone()
    conn.commit()
    return str(row["id"])


def notify_change(conn, video_id: str, action: str, stage: str | None = None) -> None:
    """Emit a Postgres NOTIFY the python-service forwards to the canvas over WS.
    `stage` is carried for action='stage' so the canvas can show live progress.
    Best-effort: a failure here must never fail the analysis run."""
    payload = {"type": "video", "action": action, "video_id": video_id}
    if stage is not None:
        payload["stage"] = stage
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT pg_notify('rainy_change', %s)", (json.dumps(payload),))
        conn.commit()
    except Exception:
        pass
