"""Spawn analysis-worker subprocesses (fire-and-forget)."""

import os
import subprocess
import sys
from pathlib import Path

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


def spawn_analysis_worker(video_id: str) -> None:
    """Fire-and-forget: launch the analysis-worker for one video.

    Uses subprocess.Popen (returns immediately after spawning) instead of
    asyncio.create_subprocess_exec, which requires ProactorEventLoop on
    Windows and raises NotImplementedError under SelectorEventLoop.
    Uses sys.executable so the correct venv Python is always used.
    """
    entrypoint = Path(settings.worker.analyzer_entrypoint)
    subprocess.Popen(
        [sys.executable, str(entrypoint)],
        env=_worker_env(video_id),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
