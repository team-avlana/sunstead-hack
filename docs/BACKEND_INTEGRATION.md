# Backend Integration Contract

_Last updated: 2026-06-24._ **Frontend-first (D19):** the SwiftUI app is built first against a
**mock op source**, so this file is the **interface the backend must satisfy**. The frontend owns
the `CanvasOp` schema and the tool surface; the co-founder's Python backend (pipeline + FastMCP
server internals) conforms to it. Sections marked **TODO(backend)** are for the co-founder to fill
in as the backend design firms up.

> Authoritative decisions: `DECISIONS.md` D14′–D19. Rationale/latency analysis: `FEASIBILITY.md`.

## 1. The op bus — `CanvasOp` (frontend-owned, source of truth)

Every canvas change — whether from the user, the live fast-model (Engine B), or the agent (Engine A)
— is expressed as a typed `CanvasOp`. The app's single `@MainActor apply()` reducer is the only
serialization point. Proposed initial op set (Swift enum; refine during frontend build):

```
enum CanvasOp {
  case addNode(id, type, x, y, payload, refKind?, refId?)
  case moveNode(id, x, y)
  case resizeNode(id, w, h)
  case setNodeText(id, text)
  case setNodeZ(id, fractionalIndex)      // z is a fractional-index STRING, not a float
  case deleteNode(id)                      // keeps a tombstone snapshot for undo
  case addEdge(id, fromNodeId, toNodeId, kind, label?)
  case deleteEdge(id)
}
struct OpEnvelope { txnID; lamport; origin (user|engineB|engineA); ops: [CanvasOp] }
```

Rules (from FEASIBILITY §1.5): one user intent → **one** `OpEnvelope` (batch). Batches share a
`txnID` = one undo step. Per-(record, property) last-write-wins, ordered by the `@MainActor`
Lamport counter. Agent ops animate (`withAnimation` ~150–200ms); user drags apply instantly.

## 2. MCP tool surface the backend must expose (FastMCP, stdio)

The frontend/agent expect these tools. **Expose the BATCH mutator only — no single-node mutators
to the agent** (D15a).

| Tool | Direction | Contract |
|------|-----------|----------|
| `apply_canvas_ops(project_id, ops:[...])` | agent → app | The ONLY canvas mutator. Applies a batch atomically; returns inverse for undo. |
| `get_canvas(project_id)` | read | nodes + edges |
| `get_app_state()` | read | counts / status |
| `list_videos(creator_id?, limit)` | read | videos + download/analysis status |
| `list_creators()` | read | **TODO(backend)** |
| `get_video_analysis(video_id)` | read | scenes + VLM results — **TODO(backend)** |
| pipeline triggers (download / scene-detect / analyze) | agent → backend | **TODO(backend):** names, params, job semantics |

A reference stub of these lives in `mcp-server/rainy_mcp/server.py` (frontend can mock against it).

## 3. Live-update channel (app-owned sidecar instance) — D14′

Single live writer = the **app-spawned** sidecar. Path: sidecar `stdout` → Swift `AsyncStream` →
`@MainActor apply()`. Notification shape (newline-delimited JSON or `canvas/ops` JSON-RPC
notification): `{ "event": "...", "payload": {...} }`. The **Claude-Code-spawned** instance is
non-real-time: it writes SQLite + pings the app over an authenticated `127.0.0.1` socket to trigger
a re-fetch through the same `apply()` funnel. **TODO(backend):** finalize the notification method
name + the localhost-socket auth handshake (per-launch token).

## 4. Shared store — SQLite (WAL)

Reference schema: `mcp-server/schema.sql`; data model: `DATA_MODEL.md`. **Swift (GRDB) owns
migrations**; Python reads/writes the same file (sqlite3/SQLModel), WAL + `busy_timeout=5000`.
Persist on a ~250–500ms debounce, not per op.

## 5. Model-routing interface (keep pluggable — D16)

The frontend calls an abstract `AnalysisRouter` / `CanvasModelRouter`; concrete backends (on-device
Foundation Models v3, Claude/Gemini/GPT vision via API) are swappable. **TODO(backend):** define the
request/response shape for (a) live canvas-op generation and (b) keyframe/scene VLM analysis, plus
the **eval/benchmark harness** that picks best-data-in-shortest-time. PySceneDetect always runs for
scene separation regardless of the chosen VLM.

## 6. Pipeline (co-founder-owned)

`yt-dlp` (URL → local mp4 + metadata) → PySceneDetect (scenes) → ffmpeg/PyAV (keyframes) → VLM. URL
download is the marketed hero (D18) with mitigations retained. **TODO(backend):** job model
(`download`/`scene_detect`/`analyze`), progress reporting back to the app (via the `job` table +
live channel), retention policy (720p cap + analyze-then-evict).

## What the frontend needs from the co-founder (to unblock real wiring)
1. Final MCP tool list + JSON schemas (section 2 TODOs).
2. The live notification method name + localhost-socket auth (section 3).
3. The `AnalysisRouter` request/response contract (section 5).
4. Confirmation of the SQLite schema vs `schema.sql` / `DATA_MODEL.md`.
5. Toolchain target (OQ9: Swift 6.4 / macOS 27 SDK assumed).
