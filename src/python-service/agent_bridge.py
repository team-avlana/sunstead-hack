"""Agent bridge — our own assistant, hosted by this service over a websocket.

This is the default right-panel experience (canvas-ui/components/AgentPanel.tsx).
Where pty_bridge.py hosts the user's *own* `claude` CLI under their login, this
runs a self-controlled agent on the **Claude Agent SDK**, authenticating with a
company-owned credential from the process env — so end users never bring Claude
credentials. The agent drives the very same local MCP tools the canvas exposes,
so anything it creates (artifacts, storyboards) shows up on the canvas via the
existing Postgres → /ws change-signal path; no extra wiring.

    browser  ──ws JSON {type:"user",text}──▶  this endpoint ──▶ ClaudeSDKClient
    chat UI  ◀──ws JSON {assistant|tool_use|turn_end|…}──────  (Agent SDK stream)

Model is chosen per chat: the panel opens the socket with ?model=<id>; changing
the model in the UI reconnects with a new value (the SDK fixes the model for a
client's lifetime). Provider routing (Anthropic vs Azure Foundry) is global env
config applied once at import — see _apply_provider_env() and config.AgentConfig.

Protocol
  client → server : JSON text frames
      {"type": "user", "text": "<the user's message>"}
  server → client : JSON text frames
      {"type": "ready",      "model": "<id>"}
      {"type": "assistant",  "text": "<a complete text block>"}
      {"type": "thinking",   "text": "<reasoning summary>"}
      {"type": "tool_use",   "name": "<tool>", "input": {...}}
      {"type": "tool_result","name": "<tool>", "is_error": false}
      {"type": "turn_end",   "usage": {...} | null}
      {"type": "error",      "message": "<text>"}

Security: same trust boundary as the rest of the service (binds 127.0.0.1, no
auth — see the note in server.py). The agent is whitelisted to the MCP tool
surface only (allowed_tools below) and runs with permission prompts bypassed,
which is safe here because every MCP tool is local CRUD against our own Postgres.
"""

import json
import logging
import os
from typing import Any

from starlette.websockets import WebSocket, WebSocketDisconnect

from config import settings

log = logging.getLogger("rainy.agent")

# Import the SDK lazily/defensively: the service must still boot (and the Claude
# Code PTY panel must still work) on a box where claude-agent-sdk isn't installed.
try:
    from claude_agent_sdk import (
        AssistantMessage,
        ClaudeAgentOptions,
        ClaudeSDKClient,
        ResultMessage,
        SystemMessage,
        TextBlock,
        ThinkingBlock,
        ToolUseBlock,
    )

    _SDK_AVAILABLE = True
except ImportError:  # pragma: no cover - exercised only without the dep installed
    AssistantMessage = ClaudeAgentOptions = ClaudeSDKClient = ResultMessage = Any  # type: ignore
    SystemMessage = TextBlock = ThinkingBlock = ToolUseBlock = Any  # type: ignore
    _SDK_AVAILABLE = False

# Token-level streaming is opt-in via include_partial_messages; the StreamEvent
# type only exists on SDK versions that support it. When present we render the
# fine-grained deltas; otherwise we fall back to whole-block messages.
try:
    from claude_agent_sdk.types import StreamEvent

    _PARTIAL = True
except ImportError:  # pragma: no cover
    StreamEvent = Any  # type: ignore
    _PARTIAL = False

# Local alias for our MCP server inside the SDK; tools become `mcp__rainey__<tool>`.
_MCP_ALIAS = "rainey"
_MCP_URL = f"http://127.0.0.1:{settings.server.port}/mcp"

# Constrain the agent to the canvas's MCP surface — it's a preproduction
# assistant, not a coding agent, so it gets no shell/file tools.
_ALLOWED_TOOLS = [f"mcp__{_MCP_ALIAS}__*"]

# Concise steer; the bulk of the workflow guidance is delivered by the MCP server's
# own `instructions` (see server.py) and each tool's description.
_SYSTEM_PROMPT = (
    "You are Rainey, a video preproduction assistant embedded in the user's canvas app. "
    "Help the creator research, ideate, script, storyboard, and plan shot lists. The canvas "
    "is your primary output surface: use the available MCP tools (create_artifact, "
    "generate_storyboard_frame, the analysis and creator tools, memory) to put your work on "
    "the canvas rather than only describing it in chat. You also run the UGC review loop for "
    "agencies: turn briefs into frames, analyze creators' final videos, and review each "
    "delivery against its brief as a frame of text/video blocks. Follow the workflow and "
    "conventions described in the MCP server instructions. Be concise and concrete in chat."
)


def _apply_provider_env() -> None:
    """Export the company-owned credential into the env the Agent SDK engine reads.

    Provider routing is process-env config read once at engine startup. Two modes:

    - Azure Foundry (cfg.foundry_resource set): the engine has a dedicated Foundry
      client. A plain ANTHROPIC_BASE_URL does NOT work — it makes the engine send
      first-party-only beta headers Azure rejects (400). Instead set
      CLAUDE_CODE_USE_FOUNDRY + ANTHROPIC_FOUNDRY_RESOURCE + ANTHROPIC_FOUNDRY_API_KEY,
      and leave the first-party vars unset so the engine picks the Foundry path.
    - Direct Anthropic (no resource): set ANTHROPIC_BASE_URL (optional) + ANTHROPIC_API_KEY.

    Uses setdefault so an operator can override any of these from the real env.
    """
    cfg = settings.agent
    if cfg.foundry_resource:
        os.environ.setdefault("CLAUDE_CODE_USE_FOUNDRY", "1")
        os.environ.setdefault("ANTHROPIC_FOUNDRY_RESOURCE", cfg.foundry_resource)
        if cfg.api_key:
            os.environ.setdefault("ANTHROPIC_FOUNDRY_API_KEY", cfg.api_key)
    else:
        if cfg.base_url:
            os.environ.setdefault("ANTHROPIC_BASE_URL", cfg.base_url)
        if cfg.api_key:
            os.environ.setdefault("ANTHROPIC_API_KEY", cfg.api_key)


_apply_provider_env()


def _build_options(model: str) -> "ClaudeAgentOptions":
    opts: dict[str, Any] = dict(
        model=model,
        system_prompt=_SYSTEM_PROMPT,
        mcp_servers={_MCP_ALIAS: {"type": "http", "url": _MCP_URL}},
        allowed_tools=_ALLOWED_TOOLS,
        # Non-interactive: there is no human at a terminal to approve tool calls,
        # and every allowed tool is local CRUD against our own DB.
        permission_mode="bypassPermissions",
    )
    if _PARTIAL:
        opts["include_partial_messages"] = True  # token-level streaming
    return ClaudeAgentOptions(**opts)


async def _emit(ws: WebSocket, payload: dict) -> None:
    try:
        await ws.send_text(json.dumps(payload))
    except Exception:  # client went away mid-send
        raise WebSocketDisconnect()


async def _stream_partial(ws: WebSocket, event: dict) -> None:
    """Translate one raw Agent-SDK stream event into a websocket delta event.

    `event` is the raw Anthropic streaming event dict carried on StreamEvent.event.
    We surface incremental text + thinking and the *start* of each tool call (the
    name is enough to render the chip; the JSON args stream in but we don't show
    them). Tool execution results land on later turns, not here.
    """
    etype = event.get("type")
    if etype == "content_block_delta":
        delta = event.get("delta") or {}
        dtype = delta.get("type")
        if dtype == "text_delta":
            chunk = delta.get("text", "")
            if chunk:
                await _emit(ws, {"type": "assistant_delta", "text": chunk})
        elif dtype == "thinking_delta":
            chunk = delta.get("thinking", "")
            if chunk:
                await _emit(ws, {"type": "thinking_delta", "text": chunk})
    elif etype == "content_block_start":
        block = event.get("content_block") or {}
        if block.get("type") == "tool_use":
            await _emit(ws, {"type": "tool_use", "name": block.get("name", "tool")})


async def _stream_blocks(ws: WebSocket, message: "AssistantMessage") -> None:
    """Fallback for SDKs without token streaming: emit whole content blocks."""
    for block in message.content:
        if isinstance(block, TextBlock):
            if block.text:
                await _emit(ws, {"type": "assistant", "text": block.text})
        elif isinstance(block, ThinkingBlock):
            if block.thinking:
                await _emit(ws, {"type": "thinking", "text": block.thinking})
        elif isinstance(block, ToolUseBlock):
            await _emit(ws, {"type": "tool_use", "name": block.name})


async def _emit_mcp_probe(ws: WebSocket) -> None:
    """Confirm the MCP tool surface at connect time, before the first message.

    The authoritative status arrives on the first turn's init SystemMessage (see
    _emit_mcp_status), but that only fires once the user sends a message — until
    then the panel's pill sits in its 'connecting' state and reads as "off".
    Probe the same HTTP MCP endpoint the agent uses (FastMCP's Client runs the
    full initialize + tools/list handshake) and report the tool count now. The
    init message still overwrites this with the agent's real inventory later.
    """
    try:
        from fastmcp import Client

        async with Client(_MCP_URL) as c:
            tools = await c.list_tools()
        await _emit(ws, {"type": "mcp", "status": "connected", "tools": len(tools)})
    except WebSocketDisconnect:
        raise
    except Exception as exc:  # never fail the session on a best-effort probe
        log.debug("mcp connect probe skipped: %r", exc)


async def _emit_mcp_status(ws: WebSocket, data: dict) -> None:
    """Translate the init SystemMessage's MCP/tool inventory into a status event.

    `data` is the init payload. It reports each configured MCP server's connection
    status and the full tool list the session loaded — the authoritative answer to
    "did the agent actually connect to our MCP?". We report our own server (the
    `rainey` alias) plus how many of its tools came through.
    """
    servers = data.get("mcp_servers") or []
    tools = data.get("tools") or []
    tool_count = sum(1 for t in tools if isinstance(t, str) and t.startswith(f"mcp__{_MCP_ALIAS}__"))

    status = "error"
    for s in servers:
        if isinstance(s, dict) and s.get("name") == _MCP_ALIAS:
            # SDK reports e.g. {"name": "rainey", "status": "connected"|"failed"}.
            status = "connected" if str(s.get("status", "")).lower() == "connected" else "error"
            break
    else:
        # No per-server record — infer from whether any tools actually loaded.
        status = "connected" if tool_count > 0 else "error"

    await _emit(ws, {"type": "mcp", "status": status, "tools": tool_count})


async def _stream_turn(ws: WebSocket, client: "ClaudeSDKClient") -> None:
    """Relay one assistant turn from the SDK to the websocket as JSON events."""
    async for message in client.receive_response():
        if _PARTIAL and isinstance(message, StreamEvent):
            await _stream_partial(ws, message.event)
        elif isinstance(message, SystemMessage):
            # The init message (first turn) carries MCP server + tool inventory.
            if getattr(message, "subtype", None) == "init":
                await _emit_mcp_status(ws, getattr(message, "data", {}) or {})
        elif isinstance(message, AssistantMessage):
            # With token streaming on, the consolidated message duplicates the
            # deltas we already sent — only render it in block-fallback mode.
            if not _PARTIAL:
                await _stream_blocks(ws, message)
        elif isinstance(message, ResultMessage):
            # Surface a failed turn (provider/auth error, max turns, refusal) so the
            # UI can explain an empty response instead of silently going idle.
            subtype = getattr(message, "subtype", None)
            if getattr(message, "is_error", False) or (subtype and subtype != "success"):
                detail = getattr(message, "result", None) or subtype or "the turn ended with an error"
                log.warning("agent result error: subtype=%s detail=%s", subtype, detail)
                await _emit(ws, {"type": "error", "message": str(detail)})
            await _emit(ws, {
                "type": "turn_end",
                "usage": getattr(message, "usage", None),
                "subtype": subtype,
            })
            return
    # Stream ended without a ResultMessage (interrupt / error) — still release the UI.
    await _emit(ws, {"type": "turn_end", "usage": None})


async def agent_endpoint(ws: WebSocket) -> None:
    if not _SDK_AVAILABLE:
        await ws.close(code=1011, reason="agent SDK not installed")
        return
    if not settings.agent.enabled:
        await ws.close(code=1011, reason="agent disabled")
        return

    model = ws.query_params.get("model") or settings.agent.model
    await ws.accept()

    try:
        async with ClaudeSDKClient(options=_build_options(model)) as client:
            await _emit(ws, {"type": "ready", "model": model})
            # Confirm the MCP tool surface up front so the panel's pill shows the
            # real count immediately instead of waiting for the first message.
            await _emit_mcp_probe(ws)
            while True:
                raw = await ws.receive_text()
                try:
                    msg = json.loads(raw)
                except (ValueError, TypeError):
                    continue
                if msg.get("type") != "user":
                    continue
                text = str(msg.get("text", "")).strip()
                if not text:
                    continue
                try:
                    await client.query(text)
                    await _stream_turn(ws, client)
                except WebSocketDisconnect:
                    raise
                except Exception as exc:  # one bad turn shouldn't kill the session
                    log.warning("agent turn failed: %r", exc)
                    await _emit(ws, {"type": "error", "message": str(exc)})
                    await _emit(ws, {"type": "turn_end", "usage": None})
    except WebSocketDisconnect:
        pass
    except Exception as exc:  # spawn/connect failure
        log.warning("agent session failed: %r", exc)
        try:
            await _emit(ws, {"type": "error", "message": str(exc)})
        except Exception:
            pass
    finally:
        try:
            await ws.close()
        except Exception:
            pass
