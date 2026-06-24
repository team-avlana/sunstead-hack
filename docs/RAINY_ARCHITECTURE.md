# Rainy — Architecture (working draft)

> ⚠️ **Not canonical.** The authoritative architecture is **[`architecture.md`](architecture.md)** (team)
> and the data model is **[`../src/database/schema.sql`](../src/database/schema.sql)**. This file is an
> earlier system sketch (pre-merge) kept for its reasoning; parts are superseded (stdio→HTTP,
> SQLite→Postgres). See [`INTEGRATION_NOTES.md`](INTEGRATION_NOTES.md) and [`FEASIBILITY.md`](FEASIBILITY.md).

_Last updated: 2026-06-24. This is a first-pass sketch; refine as the knowledge base fills in._

```
┌─────────────────────────────────────────────────────────────────────┐
│                          macOS 27 (Golden Gate)                       │
│                                                                       │
│   ┌──────────────────────────┐      ┌──────────────────────────┐      │
│   │   Rainy.app (SwiftUI)    │      │   MenuBarExtra (Rainy)   │      │
│   │  • Home (dashboards)     │      │  • status, quick capture │      │
│   │  • Infinite Canvas       │◄────►│  • trigger analyses      │      │
│   │  • Liquid Glass UI       │      └──────────────────────────┘      │
│   └──────────┬───────────────┘                                        │
│              │ in-process                                             │
│   ┌──────────▼───────────────┐   on-device, private                   │
│   │  AI services (Swift)     │──► Foundation Models v3 (LLM + images)  │
│   │                          │──► Vision (OCR/image understanding)     │
│   │                          │──► Speech / SpeechAnalyzer              │
│   │                          │──► Writing Tools / App Intents          │
│   └──────────┬───────────────┘                                        │
│              │ shared store (SQLite likely)                            │
│   ┌──────────▼───────────────┐                                        │
│   │   Data store             │                                        │
│   └──────────┬───────────────┘                                        │
│              │ reads/writes                                           │
│   ┌──────────▼───────────────────────────┐                            │
│   │  FastMCP server (Python)             │  ← bundled sidecar         │
│   │  stdio transport (HTTP localhost PoC)│                            │
│   │  Tools: query data, mutate canvas,   │                            │
│   │  run analyses, manage projects       │                            │
│   └──────────┬───────────────────────────┘                            │
└──────────────┼────────────────────────────────────────────────────────┘
               │ stdio (MCP)
        ┌──────▼───────────────┐         ┌──────────────────────────┐
        │  Claude Code (local) │   and   │  Real-time fast model    │
        │  heavy agent work    │         │  ("Codex Spark"-class)   │
        └──────────────────────┘         │  live canvas editing     │
                                         └──────────────────────────┘
```

## Resolved directions (see `DECISIONS.md` R1–R8)

The knowledge-base build answered most of the questions below. Headlines:

- **Live canvas updates ride the MCP stdio pipe**, not store-polling: the sidecar emits JSON-RPC
  notifications on stdout → `AsyncStream` → `@MainActor` → `@Observable` model → SwiftUI re-renders.
  (So in the diagram, the dashed "reads/writes" to the store is for persistence; the **real-time
  notify path is the stdio arrow itself**, bidirectional.)
- **Shared store = plain SQLite (WAL)**, GRDB (Swift) + sqlite3/SQLModel (Python). Not SwiftData.
- **Sidecar = standalone CPython via `uv` in `Contents/Resources/`**, launched with `Process`,
  Developer ID + notarized.
- **Canvas = `@Observable` world-coordinate store + camera, hybrid Canvas/culled-views render.**

## Original architectural questions (now mostly answered — kept for context)

1. **App ⇄ Python sidecar.** How does the SwiftUI app launch/supervise the FastMCP process, and
   how do they share state? Candidates: shared SQLite file (both read/write), a local socket, or
   the app exposing a tiny HTTP/IPC API the Python tools call back into.
   → `knowledge-base/architecture-patterns/`

2. **Real-time canvas updates.** When the agent mutates the canvas, how does the change reach the
   SwiftUI view instantly? Likely: agent writes via MCP tool → store change → app observes store
   (or receives a push) → canvas re-renders. Need a low-latency notify path (file-watch, socket,
   or NSDistributedNotification / XPC).
   → `knowledge-base/canvas/` + `knowledge-base/architecture-patterns/`

3. **Who owns "truth" for the canvas?** The app (Swift model) or the shared store? Probably the
   store, with the app as the live renderer and the MCP server as a second writer.

4. **Liquid Glass on the canvas.** How to apply glass to canvas chrome/controls without breaking
   performance at scale (`GlassEffectContainer`, avoiding glass-on-glass sampling).
   → `knowledge-base/apple-platform/` + `knowledge-base/canvas/`

5. **Sandboxing & entitlements.** A sandboxed app bundling a Python interpreter that Claude Code
   talks to via stdio has entitlement/packaging implications (esp. for notarization & App Store
   vs. Developer ID distribution).
   → `knowledge-base/architecture-patterns/`

## Distribution

Likely **Developer ID + notarization** (outside the Mac App Store) given the bundled Python
sidecar and the need to interoperate with the user's local Claude Code. To be confirmed.
