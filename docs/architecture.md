# Architecture Overview

A local-first video preproduction assistant. The user's existing **Claude client**
(Claude Desktop / Claude Code) is the agent loop; it drives the system through an
MCP server. Everything else runs locally, with Postgres as the single source of truth.

> Important: the agent is the external Claude MCP client (not something
> we build). The `mac-app` is the local desktop shell; the `canvas-ui` is the web
> canvas it hosts.

## Components

### `python-service`
A long-running ASGI process (FastMCP on uvicorn) with just two jobs:
- **host the MCP server** over HTTP — the agent's tools (analyze, save/get
  memory, create/update artifacts, get analysis results). These tools read and
  write Postgres directly, and spawn the `analysis-worker` as a background
  subprocess;
- **notify the canvas** over a websocket whenever an artifact is added/updated,
  so the canvas knows to re-pull. It pushes only a change signal, never data.

### `analysis-worker`
The video pipeline, invoked per request as a background **subprocess** (not a
persistent daemon for the demo). Steps: `yt-dlp` (download) → `PySceneDetect`
(shot split) → `ffmpeg` (one representative frame per shot) → Claude vision
(per-frame analysis) → aggregate metrics into a **style profile**. Writes its
results and progress directly to Postgres.

### `canvas-ui`
A read-only infinite canvas (Next.js + tldraw) that renders the typed artifacts
the agent produces — storyboards, shot lists, idea boards, scripts, diagrams.
**Reads its data directly from Postgres**; the websocket ping from the
`python-service` only tells it when to re-pull a changed/added artifact.

### `mac-app`
The native macOS shell (Swift/SwiftUI) the user interacts with. Hosts the
`canvas-ui` (web view) and provides the local desktop experience; responsible
for launching/managing the local services.

### Database & config
Postgres is the single source of truth. All three components
(`python-service`, `analysis-worker`, `canvas-ui`) **connect to it directly**.
DB credentials are shared via a single **config file** the components read at
startup (good enough for the demo; can be hardened later).

## Interactions (broad)

```
 Claude client ──MCP/HTTP──► python-service ──spawns──► analysis-worker
                                  │
                          websocket ping (change signal only)
                                  ▼
   mac-app ◄── hosts ──    canvas-ui

   Direct DB connections (shared config file → credentials):
     python-service ──┐
     analysis-worker ─┼──►  Postgres  (single source of truth)
     canvas-ui ───────┘
```

1. The agent calls MCP tools on the `python-service`.
2. Content tools (artifacts, memory) → `python-service` writes Postgres directly,
   then pings the `canvas-ui` over websocket; the canvas pulls the changed/added
   artifact straight from Postgres.
3. Analysis tools → `python-service` spawns the `analysis-worker`, returns
   immediately, and the worker writes progress/results to Postgres directly; the
   agent reads them back through a separate "get analysis" tool.
4. The `mac-app` hosts the `canvas-ui` so the user sees artifacts appear and
   update in real time as the agent works.
