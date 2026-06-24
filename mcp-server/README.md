# mcp-server — ⚠️ SUPERSEDED

> **This early stub is superseded.** The canonical backend is the team's **`src/python-service`**
> (FastMCP over **HTTP**, **Postgres** as the source of truth — see `docs/architecture.md`). This
> folder used **stdio + SQLite** (pre-pivot; see `docs/DECISIONS.md` D22/D23) and is kept only as a
> reference for the MCP tool surface. **Do not build on it.**

The FastMCP (Python) server Rainy bundles and runs as a stdio sidecar. The user's local Claude
Code — and Rainy's real-time model router — connect here to read app data and drive the canvas.

**Before writing code, read:**
- `../knowledge-base/mcp/fastmcp.md` — FastMCP 3.x API, stdio setup, lifespan
- `../knowledge-base/mcp/mcp-protocol.md` — spec essentials (target revision 2025-11-25)
- `../knowledge-base/mcp/claude-code-mcp-integration.md` — registering with Claude Code
- `../knowledge-base/architecture-patterns/realtime-app-ipc.md` — the stdout notification path
- `../knowledge-base/architecture-patterns/persistence-shared-store.md` — SQLite WAL access

**Hard rules**
- stdio transport; **stdout is the MCP channel — log to stderr only.**
- Managed with `uv`; ships as standalone CPython in the app bundle's `Contents/Resources/`.
- Open the app-IPC bridge in FastMCP `lifespan`.

_Not yet scaffolded — see `../docs/NEXT_STEPS.md` step 2._
