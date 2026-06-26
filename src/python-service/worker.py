"""Spawn analysis-worker subprocesses (fire-and-forget)."""

import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

import dev_events
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
    if settings.llm.elevenlabs_api_key:
        base["ELEVENLABS_API_KEY"] = settings.llm.elevenlabs_api_key
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


def _close_span_on_exit(
    proc: subprocess.Popen, category: str, label: str, span_id: int, t0: float
) -> None:
    """Daemon thread: wait for a fire-and-forget worker and close its activity-bus
    span with the run duration + exit code (dev only)."""
    rc = proc.wait()
    dev_events.emit_event(
        "span", category, label, "ok" if rc == 0 else "error",
        duration_ms=(time.perf_counter() - t0) * 1000,
        detail=f"exit {rc}", span_id=span_id,
    )


def spawn_profile_builder(creator_id: str) -> None:
    """Fire-and-forget: launch build_profile.py for one creator."""
    entrypoint = _resolve_entrypoint(settings.worker.profile_entrypoint)
    log = _open_log(f"profile-{creator_id}")

    if dev_events.ENABLED:
        # Dev: tee output to the activity bus + track a span (see spawn_analysis_worker).
        proc = subprocess.Popen(
            [sys.executable, str(entrypoint)],
            env=_profile_env(creator_id),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        sid = dev_events.new_span_id()
        t0 = time.perf_counter()
        label = f"build profile {creator_id[:8]}"
        dev_events.emit_event("span", "profile", label, "start", detail=creator_id, span_id=sid)
        threading.Thread(
            target=_pump_output, args=(proc, log, "profile", creator_id), daemon=True
        ).start()
        threading.Thread(
            target=_close_span_on_exit, args=(proc, "profile", label, sid, t0), daemon=True
        ).start()
        return

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


_ERROR_HINTS = ("FAILED", "Traceback", "Error", "Exception", "failed")


def _pump_output(proc: subprocess.Popen, log, category: str, ident: str) -> None:
    """Daemon thread (dev only): copy the worker's combined stdout/stderr to its
    log file AND forward each line to the activity bus, so the Service Activity
    panel shows live per-stage progress and the full traceback on failure.

    Owns the log handle for the worker's lifetime and closes it at EOF (process
    exit). `proc.stdout` is line-buffered text."""
    writable = hasattr(log, "write")
    prefix = f"[{ident}]"
    last_progress = 0.0  # throttle yt-dlp's high-frequency progress bar
    try:
        for line in proc.stdout:  # blocks until the worker writes / exits
            if writable:
                try:
                    log.write(line.encode("utf-8", "replace"))
                except Exception:
                    pass
            text = line.rstrip("\n")
            if not text:
                continue
            # yt-dlp repaints "[download]  NN.N% ..." many times/sec. Keep the file
            # complete but emit to the bus at most ~1/s (always keep the 100% line),
            # so the panel shows progress without burying real stages.
            is_progress = "[download]" in text and "%" in text and "100%" not in text
            if is_progress:
                now = time.monotonic()
                if now - last_progress < 1.0:
                    continue
                last_progress = now
            name = text[len(prefix):].strip() if text.startswith(prefix) else text
            level = "ERROR" if any(k in text for k in _ERROR_HINTS) else "INFO"
            dev_events.emit_event("log", category, name or text, level, detail=ident[:8])
    except Exception:
        pass
    finally:
        if writable:
            try:
                log.close()
            except Exception:
                pass


def _monitor_worker(
    proc: subprocess.Popen,
    video_id: str,
    dsn: str,
    span_id: int = 0,
    t0: float | None = None,
) -> None:
    """Daemon thread: if the worker subprocess exits with a non-zero code
    (OOM kill, segfault, SIGKILL) and the video wasn't already marked done
    or failed by the worker's own error handler, mark it failed here.

    Also closes the activity-bus span for the run (dev only) with the total
    wall-clock duration and exit code."""
    returncode = proc.wait()
    if t0 is not None:
        dev_events.emit_event(
            "span", "analysis", f"analyze {video_id[:8]}",
            "ok" if returncode == 0 else "error",
            duration_ms=(time.perf_counter() - t0) * 1000,
            detail=f"exit {returncode}", span_id=span_id,
        )
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
    Combined stdout+stderr stream to worker-logs/<video_id>.log.

    A daemon monitor thread watches for unexpected process death (OOM, SIGKILL)
    and marks the video failed if the worker's own error handler didn't run.
    """
    entrypoint = _resolve_entrypoint(settings.worker.analyzer_entrypoint)
    log = _open_log(video_id)
    dsn = settings.db.connection_string

    if dev_events.ENABLED:
        # Dev: pipe stdout/stderr through a pump thread so the worker's live
        # progress + traceback reach the activity bus (it also writes the log
        # file). A span tracks the whole run's duration. The pump owns/closes `log`.
        proc = subprocess.Popen(
            [sys.executable, str(entrypoint)],
            env=_worker_env(video_id),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        sid = dev_events.new_span_id()
        t0 = time.perf_counter()
        dev_events.emit_event(
            "span", "analysis", f"analyze {video_id[:8]}", "start",
            detail=video_id, span_id=sid,
        )
        threading.Thread(
            target=_pump_output, args=(proc, log, "analysis", video_id), daemon=True
        ).start()
        threading.Thread(
            target=_monitor_worker, args=(proc, video_id, dsn, sid, t0), daemon=True
        ).start()
        return

    # Production: stdout goes straight to the per-run log file (unchanged path).
    try:
        proc = subprocess.Popen(
            [sys.executable, str(entrypoint)],
            env=_worker_env(video_id),
            stdout=log,
            stderr=subprocess.STDOUT,
        )
        threading.Thread(
            target=_monitor_worker, args=(proc, video_id, dsn), daemon=True
        ).start()
    finally:
        if log is not subprocess.DEVNULL:
            log.close()
