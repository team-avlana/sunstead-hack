# sunstead-hack — Rainy

A local-first **video preproduction assistant** for content creators. The user's own **Claude client
(Claude Code / Claude Desktop)** is the agent loop; it drives everything through an **MCP server over
HTTP**. An **infinite canvas** (Next.js + tldraw) renders the artifacts the agent produces —
storyboards, shot lists, idea boards, scripts, mood boards, diagrams — backed by **Postgres** as the
single source of truth.

> **Canonical architecture:** [`docs/architecture.md`](docs/architecture.md)
> **Canonical data model:** [`src/database/schema.sql`](src/database/schema.sql)
> **Current divergences to reconcile:** [`docs/INTEGRATION_NOTES.md`](docs/INTEGRATION_NOTES.md)

## Components (`src/<component>/`)

| Component | Tech | Role |
|-----------|------|------|
| `python-service` | Python · FastMCP on uvicorn (**HTTP**) | Hosts the MCP tools; reads/writes Postgres; spawns the worker; **websocket "change-signal" ping** to the canvas (never data) |
| `analysis-worker` | Python | `yt-dlp` → PySceneDetect → ffmpeg → Claude vision → style profile; writes results/progress to Postgres |
| `canvas-ui` | Next.js (App Router) + **tldraw v5** | Infinite canvas; renders artifacts; **re-pulls from Postgres** on the ping. Runs as a web app and inside the WebView |
| `mac-app` | Swift / SwiftUI + WKWebView | Native shell hosting `canvas-ui`; launches/manages the local services |
| Database | **Postgres (Aiven)** | Single source of truth; all components connect directly |

## Repository layout

```
docs/
  architecture.md          ← CANONICAL backend architecture (team)
  RAINY_ARCHITECTURE.md    ← earlier frontend/system draft (partly superseded)
  FEASIBILITY.md           ← decision-grade feasibility review (near-real-time, pipeline, Apple tools)
  DECISIONS.md             ← decision log (D1…D26)
  DATA_MODEL.md · BACKEND_INTEGRATION.md · PROJECT_OVERVIEW.md · NEXT_STEPS.md
  INTEGRATION_NOTES.md     ← reconciliation of our planning vs. the canonical design
knowledge-base/            dated, scraped reference docs ("how to build X") — READ before building
src/
  python-service/          (team) MCP server + canvas backend
  analysis-worker/         (team) video pipeline
  database/schema.sql      (team) Postgres schema — canonical data model
  canvas-ui/               Next.js + tldraw infinite canvas (frontend)
  mac-app/                 SwiftUI + WKWebView shell
mcp-server/                ⚠️ SUPERSEDED early stdio/SQLite stub — see src/python-service
```

## How the pieces were built
- `knowledge-base/` + most of `docs/` are deep, dated research (June 2026 / post-WWDC 2026).
- `src/canvas-ui` is scaffolded against **tldraw v5**. ⚠️ The canonical design makes the canvas
  **read-only** (renders artifacts, re-pulls on a websocket ping); the current scaffold is editable
  with an SSE op channel — see `docs/INTEGRATION_NOTES.md` for what to reconcile before building further.
- `src/python-service`, `src/analysis-worker`, `src/database` are the team backend.

Start with `docs/architecture.md`, then `docs/FEASIBILITY.md` and `docs/DECISIONS.md`.

## How to run

### MCP server & analysis worker

- Have Python >=3.12 installed
- Create a `venv` and activate it (e.g. via VS Code virtual env manager)
- Install the requirements from `src/python-service/requirements.txt` and `src/analysis-worker/requirements.txt`
- Run the python-service via its `server.py` or use the launch config for VS code (recommended)
- The server is active under `http://127.0.0.1:9000`