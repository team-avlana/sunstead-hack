# CLAUDE.md — Working in this repo (sunstead-hack / Rainy)

Instructions for any AI coding agent working here.

## What this is
A local-first **video preproduction assistant** for creators. The **agent is the user's own Claude
client** (Claude Code / Desktop) driving an **MCP server over HTTP**; a **tldraw infinite canvas**
renders the artifacts the agent produces, backed by **Postgres** (single source of truth).

**Read first:** `docs/architecture.md` (canonical), `src/database/schema.sql` (canonical data model),
`docs/DECISIONS.md`, `docs/FEASIBILITY.md`, and `docs/INTEGRATION_NOTES.md` (current divergences).

## Ground rules
1. **`knowledge-base/` is the source of truth for "how to build X."** Read the relevant dated doc
   before implementing anything (tldraw, FastMCP/MCP-over-HTTP, the WebView shell, the video
   pipeline, Liquid Glass, Foundation Models, etc.). Prefer it over priors — the platform moved fast
   in 2025–2026.
2. **Architecture is HTTP + Postgres** — NOT the earlier stdio + SQLite drafts. MCP transport =
   **Streamable HTTP**; DB = **Postgres (Aiven)**; realtime = **websocket change-signal → the canvas
   re-pulls from Postgres**.
3. **Component layout is `src/<component>/`.** Match surrounding style: idiomatic FastMCP/Python in
   the services, Next.js + tldraw idioms in `canvas-ui`, SwiftUI in `mac-app`.
4. **Keep decisions in `docs/DECISIONS.md`** and reconcile against `docs/architecture.md` +
   `docs/INTEGRATION_NOTES.md`.
5. **Superseded:** the root `mcp-server/` is an early stdio/SQLite stub — do **not** build on it; the
   canonical service is `src/python-service`. `docs/DATA_MODEL.md` is superseded by
   `src/database/schema.sql`.

## When a knowledge-base doc is missing or stale
Say so and add a new dated doc rather than guessing.
