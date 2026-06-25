# Next Steps

> **SUPERSEDED.** This was the pre-pivot sequenced build plan (stdio MCP, SQLite, SwiftUI-native
> infinite canvas). The architecture pivoted to HTTP + Postgres + Next.js/tldraw canvas
> (D20–D26 in `DECISIONS.md`). What was built is documented in `docs/RUNNING.md` and
> `docs/INTEGRATION_NOTES.md`. Kept for historical context only.

---

_Last updated: 2026-06-24._ Sequenced build plan. Each item names the knowledge-base doc(s) to
read first.

## 0. Unblock the data model ⛔
- **Answer OQ1 (video data source).** YouTube Data API vs. scraping vs. third-party analytics vs.
  user exports. Everything in the data model and ~half the MCP tools depend on this. **No code
  past step 2 should assume a source until this is decided.**

## 1. App skeleton
- Create the Xcode project in `app/` (SwiftUI macOS, target macOS 27, latest Xcode beta).
- One `App` with `WindowGroup(id:"main")` + `MenuBarExtra(.window)`; `.accessory`→`.regular`
  activation; `applicationShouldTerminateWhenLastWindowClosed = false`.
  → `apple-platform/menu-bar-app.md`, `apple-platform/swiftui-macos-app-structure.md`
- Apply Liquid Glass to chrome only; one `GlassEffectContainer`.
  → `apple-platform/liquid-glass-swiftui.md`

## 2. MCP server skeleton
- FastMCP 3.x server in `mcp-server/`, stdio transport, `uv`-managed.
- Stub tools: `ping`, `get_app_state`, `canvas.add_node`, `canvas.move_node`, `canvas.connect`.
- Open the app-IPC bridge in `lifespan`. Log to **stderr only** (stdout is the MCP channel).
  → `mcp/fastmcp.md`, `mcp/mcp-protocol.md`

## 3. Wire app ⇄ sidecar
- Swift launches the bundled CPython sidecar via `Process`; read stdout via `AsyncStream`.
- Define the JSON-RPC notification shape for canvas mutations (the real-time path).
  → `architecture-patterns/realtime-app-ipc.md`, `architecture-patterns/python-sidecar-in-mac-app.md`
- Register the server with the user's Claude Code (user scope, absolute bundled-interpreter path).
  → `mcp/claude-code-mcp-integration.md`

## 4. Shared store
- SQLite (WAL, busy_timeout), GRDB migrations on Swift side; Python reads/writes the same file.
- Sidecar signals the app (over stdout) after writes so the app re-fetches.
  → `architecture-patterns/persistence-shared-store.md`

## 5. Infinite canvas
- `@Observable @MainActor CanvasStore` (world coords) + `Viewport` camera; hybrid render; culling.
- Agent `Mutation` commands applied on `@MainActor`, coalesced per frame.
  → `canvas/infinite-canvas-swiftui.md`

## 6. On-device AI features
- Foundation Models v3: thumbnail/frame analysis via **image-in-prompt**, guided generation, tools.
  → `ai-on-device/foundation-models-v3.md`
- Vision OCR on thumbnails; SpeechAnalyzer transcription of video audio.
  → `ai-on-device/vision-framework.md`, `ai-on-device/speech-framework.md`
- App Intents for "analyze creator / compare videos / add to canvas" (Siri/Shortcuts/Spotlight).
  → `ai-on-device/writing-tools-app-intents.md`

## 7. Real-time model routing
- Implement the tiered router (Groq/Cerebras hot path · Haiku 4.5 reasoning · FM offline · Claude
  Code heavy). Keep a feature flag to swap in Codex‑Spark when its API ships.
  → `models/realtime-fast-models.md`

## Re-scrape triggers
Re-run the knowledge-base research when: macOS 27 hits GM, a new Xcode beta lands, Foundation
Models symbol names are confirmed against shipping docs, or Codex‑Spark gets a public API.
