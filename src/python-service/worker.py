"""Spawn analysis-worker subprocesses (fire-and-forget)."""

import os
import subprocess
import sys
from pathlib import Path

from config import settings

# Per-run logs so a failed/fire-and-forget worker isn't a black box. Without this
# the only trace of a failure is videos.analysis_error; the full stdout/traceback
# would go to DEVNULL. Tail: src/python-service/worker-logs/<video_id>.log
_LOG_DIR = Path(__file__).resolve().parent / "worker-logs"


def _resolve_entrypoint(path_str: str) -> Path:
    """Resolve a worker entrypoint. Relative paths (the default
    '../analysis-worker/main.py') resolve against THIS file's dir, not the CWD,
    so the worker is found regardless of where the server was launched from."""
    p = Path(path_str)
    if not p.is_absolute():
        p = (Path(__file__).resolve().parent / p).resolve()
    return p


def _open_log(name: str):
    """A binary append handle for one worker's combined stdout+stderr, or DEVNULL
    if the log dir can't be created (logging must never block analysis)."""
    try:
        _LOG_DIR.mkdir(parents=True, exist_ok=True)
        return open(_LOG_DIR / f"{name}.log", "ab", buffering=0)
    except Exception:
        return subprocess.DEVNULL


def _augmented_path(base_path: str) -> str:
    """Guarantee the spawned worker finds its CLI deps regardless of how the server
    was launched. The worker shells out to bare `ffmpeg`/`ffprobe`/`yt-dlp`; if the
    server's own PATH is minimal (e.g. launched by the mac-app or a process manager)
    those wouldn't resolve. Prepend the venv's bin (yt-dlp) and the usual Homebrew
    prefixes (ffmpeg) so analysis works no matter the parent PATH."""
    extra = [str(Path(sys.executable).parent), "/opt/homebrew/bin", "/usr/local/bin"]
    parts = extra + (base_path.split(os.pathsep) if base_path else [])
    seen: set[str] = set()
    out: list[str] = []
    for p in parts:
        if p and p not in seen:
            seen.add(p)
            out.append(p)
    return os.pathsep.join(out)


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
    env["PATH"] = _augmented_path(env.get("PATH", ""))
    return _llm_env(env)


def _profile_env(creator_id: str) -> dict[str, str]:
    env = {**os.environ}
    env["CREATOR_ID"] = creator_id
    env["DB_CONNECTION_STRING"] = settings.db.connection_string
    env["PATH"] = _augmented_path(env.get("PATH", ""))
    return _llm_env(env)


def spawn_profile_builder(creator_id: str) -> None:
    """Fire-and-forget: launch build_profile.py for one creator."""
    entrypoint = _resolve_entrypoint(settings.worker.profile_entrypoint)
    log = _open_log(f"profile-{creator_id}")
    try:
        subprocess.Popen(
            [sys.executable, str(entrypoint)],
            env=_profile_env(creator_id),
            stdout=log,
            stderr=subprocess.STDOUT,
        )
    finally:
        # The child inherited a dup of the fd; closing the parent's copy is safe.
        if log is not subprocess.DEVNULL:
            log.close()


def spawn_analysis_worker(video_id: str) -> None:
    """Fire-and-forget: launch the analysis-worker for one video.

    Uses subprocess.Popen (returns immediately after spawning) instead of
    asyncio.create_subprocess_exec, which requires ProactorEventLoop on
    Windows and raises NotImplementedError under SelectorEventLoop.
    Uses sys.executable so the correct venv Python is always used.
    Combined stdout+stderr stream to worker-logs/<video_id>.log.
    """
    entrypoint = _resolve_entrypoint(settings.worker.analyzer_entrypoint)
    log = _open_log(video_id)
    try:
        subprocess.Popen(
            [sys.executable, str(entrypoint)],
            env=_worker_env(video_id),
            stdout=log,
            stderr=subprocess.STDOUT,
        )
    finally:
        if log is not subprocess.DEVNULL:
            log.close()
