import json
import psycopg
from psycopg.rows import dict_row


def get_connection(dsn: str):
    return psycopg.connect(dsn, row_factory=dict_row)


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
        cur.execute("UPDATE videos SET analysis_error=NULL WHERE id=%s", (video_id,))
    conn.commit()


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
    frame_path: str | None,
    analysis: dict,
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO shots (video_id, idx, start_sec, end_sec, frame_path, analysis)
               VALUES (%s, %s, %s, %s, %s, %s)
               ON CONFLICT (video_id, idx) DO UPDATE SET
                 start_sec = EXCLUDED.start_sec,
                 end_sec   = EXCLUDED.end_sec,
                 frame_path = EXCLUDED.frame_path,
                 analysis  = EXCLUDED.analysis""",
            (video_id, idx, start_sec, end_sec, frame_path, json.dumps(analysis)),
        )


def write_video_metrics(conn, video_id: str, metrics: dict) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE videos SET metrics=%s WHERE id=%s",
            (json.dumps(metrics), video_id),
        )


def set_analyzed_at(conn, video_id: str) -> None:
    with conn.cursor() as cur:
        cur.execute("UPDATE videos SET analyzed_at=now() WHERE id=%s", (video_id,))
    conn.commit()


def set_analysis_error(conn, video_id: str, error: str) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE videos SET analysis_error=%s WHERE id=%s",
            (error[:2000], video_id),
        )
    conn.commit()
