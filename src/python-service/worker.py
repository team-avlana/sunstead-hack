"""Spawn analysis-worker subprocesses (fire-and-forget)."""

import os
import subprocess
import sys
from pathlib import Path

from config import settings


def _worker_env(video_id: str) -> dict[str, str]:
    env = {**os.environ}
    env["VIDEO_ID"] = video_id
    env["DB_CONNECTION_STRING"] = settings.db.connection_string
    if settings.llm.azure_anthropic_url:
        env["AZURE_ANTHROPIC_URL"] = settings.llm.azure_anthropic_url
    if settings.llm.azure_anthropic_key:
        env["AZURE_ANTHROPIC_KEY"] = settings.llm.azure_anthropic_key
    return env


def spawn(video_id: str) -> None:
    """Fire-and-forget: launch the analysis-worker for one video.

    Uses subprocess.Popen (returns immediately after spawning) instead of
    asyncio.create_subprocess_exec, which requires ProactorEventLoop on
    Windows and raises NotImplementedError under SelectorEventLoop.
    Uses sys.executable so the correct venv Python is always used.
    """
    entrypoint = Path(settings.worker.entrypoint)
    subprocess.Popen(
        [sys.executable, str(entrypoint)],
        env=_worker_env(video_id),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
