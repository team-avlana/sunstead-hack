"""Spawn analysis-worker subprocesses (fire-and-forget)."""

import json
import os
import subprocess
import sys
import threading
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

from config import settings


def _llm_env(base: dict[str, str]) -> dict[str, str]:
    """Inject whichever Anthropic credentials are configured."""
    if settings.llm.anthropic_api_key:
        base["ANTHROPIC_API_KEY"] = settings.llm.anthropic_api_key
    if settings.llm.azure_anthropic_url:
        base["AZURE_ANTHROPIC_URL"] = settings.llm.azure_anthropic_url
    if settings.llm.azure_anthropic_key:
        base["AZURE_ANTHROPIC_KEY"] = settings.llm.azure_anthropic_key
    return base


def _worker_env(video_id: str) -> dict[str, str]:
    env = {**os.environ}
    env["VIDEO_ID"] = video_id
    env["DB_CONNECTION_STRING"] = settings.db.connection_string
    return _llm_env(env)


def _profile_env(creator_id: str) -> dict[str, str]:
    env = {**os.environ}
    env["CREATOR_ID"] = creator_id
    env["DB_CONNECTION_STRING"] = settings.db.connection_string
    return _llm_env(env)


def spawn_profile_builder(creator_id: str) -> None:
    """Fire-and-forget: launch build_profile.py for one creator."""
    entrypoint = Path(settings.worker.profile_entrypoint)
    subprocess.Popen(
        [sys.executable, str(entrypoint)],
        env=_profile_env(creator_id),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def _monitor_worker(proc: subprocess.Popen, video_id: str, dsn: str) -> None:
    """Daemon thread: if the worker subprocess exits with a non-zero code
    (OOM kill, segfault, SIGKILL) and the video wasn't already marked done
    or failed by the worker's own error handler, mark it failed here."""
    returncode = proc.wait()
    if returncode == 0:
        return
    try:
        with psycopg.connect(dsn, row_factory=dict_row) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE videos "
                    "SET analysis_error=%s, analysis_stage=NULL "
                    "WHERE id=%s AND analyzed_at IS NULL AND analysis_error IS NULL",
                    (f"Worker process crashed (exit code {returncode})", video_id),
                )
                updated = cur.rowcount
            conn.commit()
            if updated:
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT pg_notify('rainy_change', %s)",
                        (json.dumps({"type": "video", "action": "error", "video_id": video_id}),),
                    )
                conn.commit()
    except Exception:
        pass


def spawn_analysis_worker(video_id: str) -> None:
    """Fire-and-forget: launch the analysis-worker for one video.

    Uses subprocess.Popen (returns immediately after spawning) instead of
    asyncio.create_subprocess_exec, which requires ProactorEventLoop on
    Windows and raises NotImplementedError under SelectorEventLoop.
    Uses sys.executable so the correct venv Python is always used.
    A daemon monitor thread watches for unexpected process death (OOM, SIGKILL)
    and marks the video failed if the worker's own error handler didn't run.
    """
    entrypoint = Path(settings.worker.analyzer_entrypoint)
    proc = subprocess.Popen(
        [sys.executable, str(entrypoint)],
        env=_worker_env(video_id),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    threading.Thread(
        target=_monitor_worker,
        args=(proc, video_id, settings.db.connection_string),
        daemon=True,
    ).start()
