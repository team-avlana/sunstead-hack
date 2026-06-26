"""
python-service — MCP server + websocket notification hub.

Start with:
    python server.py

Do NOT start with `python -m uvicorn server:app` — uvicorn creates its event loop
before importing this module, so the WindowsSelectorEventLoopPolicy fix below fires
too late and psycopg async fails on Windows.

FastMCP 3.x serves over streamable-HTTP (Starlette under the hood).
We obtain the ASGI app from FastMCP and mount it inside our own Starlette
app that also declares the /ws WebSocketRoute.
"""

import asyncio
import sys
from contextlib import asynccontextmanager

# psycopg async requires SelectorEventLoop; Windows defaults to ProactorEventLoop.
if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

import uvicorn
from fastmcp import FastMCP
from starlette.applications import Starlette
from starlette.middleware.cors import CORSMiddleware
from starlette.routing import Mount, Route, WebSocketRoute

import agent_bridge
import db
import dev_events
import notify
import pty_bridge
from block_normalize import BLOCK_TAXONOMY_GUIDE, WRITING_STYLE_GUIDE
from config import settings
from agency_routes import routes as agency_routes
from review_workflow import UGC_REVIEW_GUIDE
from routes_api import routes as api_routes
from tools import analysis, artifacts, creators, memory, projects, review, storyboard

# ── FastMCP instance ──────────────────────────────────────────────────────────

mcp = FastMCP(
    name="sunstead",
    instructions=(
        "You are a video preproduction assistant embedded inside the user's canvas app. "
        "Your job is to help a content creator research, ideate, script, storyboard, and plan "
        "shot lists for new videos. Everything you produce should be visualised on the canvas.\n\n"
        "## Active project\n"
        "The canvas reports which project the user currently has open. The project-scoped tools "
        "(create_artifact, list_artifacts) default to it when you omit project_id, and "
        "get_active_project returns it. Prefer that over asking the user which project to use.\n\n"
        "## ALWAYS do this at the start of every session\n"
        "1. Call list_creators() — find the creator with kind='self'. That is the user.\n"
        "2. Call get_style_profile(creator_id) for the self creator to load their style, tone, "
        "pacing, and content patterns. If no profile exists yet, say so and offer to run an analysis.\n"
        "3. Call list_creator_videos(creator_id) to see their recent content.\n"
        "4. Call list_memory() to reload any saved goals, audience info, or preferences.\n"
        "If no self creator exists at all, ask the user for their channel URL and call "
        "analyze_channel(url, kind='self') to onboard them.\n\n"
        "## Creator types\n"
        "- kind='self': the user's own channel. One per user. Primary context for tone and style.\n"
        "- kind='reference': competitors, role models, channels the user admires or tracks. "
        "Add as many as the user wants. Reference creators make ideation and positioning richer — "
        "strongly suggest adding them if none exist, and proactively offer to add more whenever "
        "the user mentions a channel or creator they find interesting.\n\n"
        "## Analyzing a channel (step-by-step)\n"
        "1. analyze_channel(channel_url, kind, name, max_videos=5..10) — 5-10 videos is usually "
        "enough for a solid profile; more gives better data. Analysis runs in the background.\n"
        "2. Poll get_channel_analysis(creator_id) every minute or so until done==total "
        "(each video takes 1-3 min; full channel run takes 3-10 min).\n"
        "3. Once all videos are done, call build_style_profile(creator_id). "
        "This aggregation step is MANUAL and REQUIRED — the profile does NOT build automatically.\n"
        "4. Poll get_style_profile(creator_id) until a result appears. "
        "A newer created_at means the build completed. You can then use the profile.\n"
        "Rebuilding after adding more videos is possible by calling build_style_profile again.\n\n"
        "## Preproduction workflow\n"
        "Guide the user through these phases in order, creating canvas artifacts at each step:\n"
        "1. Research — review the user's style profile and reference creator profiles for "
        "patterns, gaps, and opportunities.\n"
        "2. Ideation — propose 3-5 video ideas that fit the user's established style while "
        "offering something fresh or differentiated.\n"
        "3. Scripting — develop the audio layer (voiceover/narration/dialogue). Must closely "
        "match the creator's tone of voice as revealed by their style profile.\n"
        "4. Storyboarding — sketch the approximate visual structure scene by scene. "
        "For PAST videos use real shot frames from get_video_shots(). "
        "For FUTURE videos use generate_storyboard_frame() to create AI-generated panels.\n"
        "5. Shot list — create a concrete, actionable checklist of shots to film.\n\n"
        "## AI storyboard images for future videos\n"
        "generate_storyboard_frame(project_id, concept, shot_type, creator_id?) generates "
        "a visual panel for a planned scene using gpt-image-1.5 and places it on the canvas "
        "automatically. Use it during ideation and storyboarding phases.\n"
        "- Call once per key scene (4-8 panels for a full storyboard).\n"
        "- Pass creator_id to inherit the creator's colour palette, lighting, and mood.\n"
        "- shot_type options: 'close-up', 'medium shot', 'wide shot', "
        "'over-the-shoulder', 'POV', 'aerial', 'insert'.\n"
        "- aspect_ratio: '1:1' (default) or '16:9' for widescreen panels.\n"
        "- Position panels in a row: each call pass position={x: prev_x + w + 20, y: 0, w, h}.\n"
        "- list_storyboard_frames(project_id) shows all previously generated panels.\n"
        "When a user says 'storyboard this idea', 'visualise my concept', or 'show me "
        "what this could look like', you MUST call generate_storyboard_frame() — "
        "do not just describe the scenes in text.\n\n"
        "## Canvas artifacts — be visual, always\n"
        "The canvas is the primary output surface. Treat it as a living document.\n"
        "- Create artifacts early and iterate on them — never create a duplicate when you can "
        "update an existing one with update_artifact().\n"
        "- type='frame' is the standard block. Use payload.role to signal the phase "
        "(e.g. 'research', 'ideation', 'script', 'storyboard', 'shot_list').\n"
        "- Element types: 'text' (HTML content), 'image' (src='/frames/{frame_id}' for "
        "extracted video frames, or src='/api/storyboard/{id}' for AI-generated panels), "
        "'video' (video_id + view='compact'|'full').\n"
        "- Past-video storyboards: call get_video_shots(video_id) to get frame_ids, then "
        "place image elements with src='/frames/{frame_id}' alongside scene labels.\n"
        "- Storyboards: call get_video_shots(video_id) to get frame_ids, then place image "
        "elements with src='/frames/{frame_id}' alongside text elements for scene labels.\n"
        "- Lay out frames so they don't overlap: increment x by (w + gap) per frame.\n\n"
        "## Raw video data\n"
        "For deeper analysis beyond the style profile: get_video_shots() returns per-shot LLM "
        "analysis (shot type, composition, palette, camera movement, subjects). "
        "get_frame(frame_id) fetches the actual JPEG as a base64 data URL you can embed "
        "in image elements. Transcripts and full metrics are in the shot analysis data.\n\n"
        "## Memory\n"
        "Persist key facts with save_memory(): user goals, target audience, platform constraints, "
        "tone preferences, recurring themes. Reload with list_memory() at session start.\n\n"
        + BLOCK_TAXONOMY_GUIDE
        + "\n\n"
        + WRITING_STYLE_GUIDE
        + "\n\n"
        + UGC_REVIEW_GUIDE
    ),
)

# Register all tool groups
projects.register(mcp)
analysis.register(mcp)
artifacts.register(mcp)
memory.register(mcp)
creators.register(mcp)
storyboard.register(mcp)
review.register(mcp)

# ── Combined ASGI app ─────────────────────────────────────────────────────────

# FastMCP 3.x: http_app() returns a Starlette app whose lifespan initialises
# the internal task group. Starlette's Mount does NOT propagate sub-app
# lifespans, so we forward it explicitly via the outer app's lifespan.
_mcp_asgi = mcp.http_app()


@asynccontextmanager
async def lifespan(app: Starlette):
    async with _mcp_asgi.router.lifespan_context(app):
        # Dev-only activity bus: hand it the running loop so cross-thread emits land
        # safely, and forward stdlib logs into it. Both are no-ops unless enabled.
        dev_events.set_loop(asyncio.get_running_loop())
        dev_events.install_log_handler()
        # Bridge cross-process changes (analysis-worker, analyze_video) to WS.
        listener = asyncio.create_task(notify.pg_listen(settings.db.connection_string))
        try:
            yield
        finally:
            listener.cancel()
            try:
                await listener
            except asyncio.CancelledError:
                pass
            db.close_pool()


_app = Starlette(
    lifespan=lifespan,
    routes=[
        # Order matters: specific routes before the catch-all MCP mount at "/".
        WebSocketRoute("/ws", notify.websocket_endpoint),
        # Our own assistant (Claude Agent SDK) — the default right-panel agent.
        WebSocketRoute("/agent", agent_bridge.agent_endpoint),
        # Hosts the user's own `claude` CLI in a PTY (opt-in via Settings).
        WebSocketRoute("/pty", pty_bridge.terminal_endpoint),
        # Dev-only activity/timing stream (gated by RAINY_DEV_LOGS).
        WebSocketRoute("/dev/events", dev_events.events_websocket),
        Route("/api/dev/events", dev_events.events_snapshot),
        Route("/api/dev/status", dev_events.status_endpoint),
        *api_routes,
        *agency_routes,
        Mount("/", app=_mcp_asgi),
    ],
)

# Time every HTTP request as a span on the activity bus (no-op when disabled).
_app = dev_events.TimingMiddleware(_app)

# NOTE: wildcard CORS + no auth is intended for LOCAL use only — the server binds
# 127.0.0.1. Before any non-local/exposed deployment, restrict allow_origins to the
# known canvas origin(s), add an Origin check on the /ws handshake (CORS does not
# cover websockets), and require a token on the write tools. A malicious local web
# page can otherwise drive the MCP write surface via DNS-rebinding/cross-origin.
app = CORSMiddleware(
    _app,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["mcp-session-id"],
)

# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    uvicorn.run(
        "server:app",
        host=settings.server.host,
        port=settings.server.port,
        reload=False,
        loop="none",  # don't pass ProactorEventLoop as loop_factory; use our policy instead
    )
