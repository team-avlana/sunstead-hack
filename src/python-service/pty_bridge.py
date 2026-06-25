"""PTY bridge — host the user's own Claude Code CLI inside the canvas app.

The canvas is a static export running in a WKWebView / browser; it cannot spawn
a process. So when the right-side Claude panel opens, it opens a websocket here
and we attach it to a *real* pseudo-terminal running the `claude` CLI:

    browser  ──ws JSON {input,resize}──▶  this endpoint  ──bytes──▶  PTY ──▶ claude
    xterm.js ◀──ws binary (raw output)──  this endpoint  ◀──bytes──  PTY ◀── claude

Auth is the user's own: `claude` runs as this server's OS user and reads its
stored credentials (~/.claude), exactly as it would in a normal terminal — we
build no agent and store no keys (Option A from the integration discussion).

Protocol
  client → server : JSON text frames
      {"type": "input",  "data": "<utf-8 keystrokes>"}
      {"type": "resize", "cols": <int>, "rows": <int>}
  server → client : binary frames carrying raw PTY output (fed to xterm.write)

Security: this binds to 127.0.0.1 with the rest of the service and spawns ONLY
the configured command (no user-controlled argv), but it is still a live local
shell-equivalent. See the note in server.py before exposing the service.
"""

import asyncio
import errno
import json
import logging
import os
import signal
import struct
from pathlib import Path
from typing import Any

try:
    import fcntl
    import pty
    import termios
    _PTY_AVAILABLE = True
except ImportError:
    fcntl: Any = None
    pty: Any = None
    termios: Any = None
    _PTY_AVAILABLE = False

from starlette.websockets import WebSocket, WebSocketDisconnect

from config import settings

log = logging.getLogger("rainy.pty")

# Read at most this many bytes per PTY read; one screen of output is far less.
_READ_SIZE = 65536

# This service lives at <repo>/src/python-service; the repo root holds the
# .mcp.json that registers this very service. Hosting `claude` there (rather
# than in $HOME) is what makes our local MCP server visible to the embedded
# session — project-scoped MCP config is only loaded from the working tree.
_REPO_ROOT = Path(__file__).resolve().parents[2]
_MCP_CONFIG = _REPO_ROOT / ".mcp.json"


def _resolve_launch() -> tuple[list[str], str]:
    """Build (argv, cwd) for the embedded CLI, applying smart defaults.

    Honors RAINY_CLAUDE_COMMAND / RAINY_CLAUDE_CWD when set; otherwise opens in
    the repo root and pre-attaches its .mcp.json so the local MCP server shows
    up connected (and trusted, so the user isn't prompted to approve it)."""
    cwd = settings.terminal.cwd or str(_REPO_ROOT)
    argv = list(settings.terminal.command)
    # Only auto-inject config for the default `claude` launch — a custom command
    # (or one already passing --mcp-config) is left exactly as the user set it.
    if argv == ["claude"] and "--mcp-config" not in argv and _MCP_CONFIG.is_file():
        argv += ["--mcp-config", str(_MCP_CONFIG)]
    return argv, cwd


def _set_winsize(fd: int, rows: int, cols: int) -> None:
    """Tell the PTY its window size so claude's TUI lays out correctly."""
    rows = max(1, min(rows, 1000))
    cols = max(1, min(cols, 1000))
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    except OSError:
        pass


def _spawn() -> tuple[int, int]:
    """Fork a child whose stdio is a fresh controlling PTY, exec the CLI in it.

    Returns (pid, master_fd). `pty.fork()` gives the child a new session with the
    slave end as its controlling terminal — which the `claude` TUI requires.
    """
    pid, master_fd = pty.fork()
    if pid == 0:  # child
        env = os.environ.copy()
        env.setdefault("TERM", "xterm-256color")
        # A real interactive run: make sure the CLI doesn't think it's piped.
        env.pop("CI", None)
        argv, cwd = _resolve_launch()
        try:
            os.chdir(cwd)
        except OSError:
            pass
        try:
            os.execvpe(argv[0], argv, env)
        except OSError as exc:
            # We're in the forked child with the slave as stdout — write a human
            # message to the terminal, then exit so the parent's read loop ends.
            os.write(2, f"\r\n[rainy] failed to launch {argv[0]!r}: {exc}\r\n".encode())
            os._exit(127)
    return pid, master_fd


async def terminal_endpoint(ws: WebSocket) -> None:
    if not _PTY_AVAILABLE:
        await ws.close(code=1011, reason="PTY not available on this platform")
        return
    if not settings.terminal.enabled:
        await ws.close(code=1011, reason="terminal disabled")
        return

    await ws.accept()

    try:
        pid, master_fd = await asyncio.to_thread(_spawn)
    except Exception as exc:  # pragma: no cover - fork failures are rare
        log.warning("pty spawn failed: %r", exc)
        await ws.close(code=1011, reason="spawn failed")
        return

    os.set_blocking(master_fd, False)
    loop = asyncio.get_running_loop()
    closing = asyncio.Event()

    # PTY → websocket: registered on the event loop, fires whenever claude writes.
    def _on_readable() -> None:
        try:
            data = os.read(master_fd, _READ_SIZE)
        except OSError as exc:
            if exc.errno == errno.EAGAIN:
                return
            data = b""  # EIO etc. → child gone
        if not data:
            closing.set()
            return
        # send_bytes is a coroutine; schedule it without blocking the reader.
        asyncio.ensure_future(_safe_send(data))

    async def _safe_send(data: bytes) -> None:
        try:
            await ws.send_bytes(data)
        except Exception:
            closing.set()

    loop.add_reader(master_fd, _on_readable)

    # websocket → PTY: drive input + resize until the client goes away.
    async def _pump_input() -> None:
        try:
            while True:
                raw = await ws.receive_text()
                try:
                    msg = json.loads(raw)
                except (ValueError, TypeError):
                    continue
                kind = msg.get("type")
                if kind == "input":
                    payload = str(msg.get("data", "")).encode("utf-8", "ignore")
                    try:
                        os.write(master_fd, payload)
                    except OSError:
                        break
                elif kind == "resize":
                    try:
                        _set_winsize(master_fd, int(msg.get("rows", 24)), int(msg.get("cols", 80)))
                    except (TypeError, ValueError):
                        pass
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            closing.set()

    input_task = asyncio.create_task(_pump_input())
    try:
        await closing.wait()
    finally:
        loop.remove_reader(master_fd)
        input_task.cancel()
        # Tear the child down, then reap it so we don't leak zombies.
        for sig in (signal.SIGHUP, signal.SIGKILL):
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                break
            await asyncio.sleep(0.1)
            try:
                if os.waitpid(pid, os.WNOHANG)[0] != 0:
                    break
            except ChildProcessError:
                break
        try:
            os.close(master_fd)
        except OSError:
            pass
        try:
            await ws.close()
        except Exception:
            pass
