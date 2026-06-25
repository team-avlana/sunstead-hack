# Decisions Log

Locked-in choices from the kickoff (2026-06-24). Update with new entries; don't rewrite history.

## 2026-06-24 — Kickoff decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| D1 | App type | Native macOS app **+** menu bar companion | Deep OS integration, Liquid Glass, always-available agent surface |
| D2 | UI framework | **SwiftUI** | First-class Liquid Glass APIs, modern, fastest path to state-of-the-art look |
| D3 | OS target | **macOS 27 "Golden Gate"** + latest Xcode (beta OK) | Developer account available; want newest Liquid Glass + Foundation Models v3 |
| D4 | MCP transport | **stdio** (primary), HTTP-on-localhost as PoC | Matches prior project experience; simplest auth; one client at a time is fine |
| D5 | MCP framework | **FastMCP (Python)** | Already used in past projects; team familiarity |
| D6 | On-device AI | Foundation Models v3, Vision, Speech, Writing Tools, App Intents | All four selected at kickoff |
| D7 | Real-time agent | Ultra-fast model ("Codex Spark"-class) **if available**, else Claude Code; on-device model for local non-MCP | Real-time canvas editing needs low latency |
| D8 | Core domain | Video analysis for creators (competition, ideation, outliers, similar creators) | Defines MCP tool surface + data model |
| D9 | Hero surface | Infinite canvas driven live by the MCP agent | Primary differentiator |

## 2026-06-24 — Research-backed direction (from knowledge-base build)

These refine the architecture based on the scraped reference docs. Treated as the current
recommended path, still revisable.

| # | Topic | Direction | Source doc |
|---|-------|-----------|------------|
| R1 | App ⇄ sidecar IPC + live canvas | **Reuse the MCP stdio pipe.** Push canvas mutations as JSON-RPC notifications on stdout → Swift `bytes.lines` read loop → `AsyncStream` → hop to `@MainActor` to mutate an `@Observable` model. Lowest latency, no extra surface. Local WebSocket (Network.framework) is the fan-out fallback. Avoid XPC (can't reach Python) and `NSDistributedNotification`. | `architecture-patterns/realtime-app-ipc.md` |
| R2 | Shared persistence | **Plain SQLite, WAL mode**, 5s `busy_timeout`. GRDB on Swift, `sqlite3`/SQLModel on Python. Swift owns migrations. Do NOT share a SwiftData/Core Data store across processes. Note: GRDB `ValueObservation` can't see the sidecar's writes — the sidecar must signal the app (over the stdout pipe) to re-fetch. | `architecture-patterns/persistence-shared-store.md` |
| R3 | Sidecar packaging | **Standalone CPython** (Astral `python-build-standalone`, managed via `uv`) + pre-built FastMCP venv in `Contents/Resources/`; launch from Swift via `Process`. **Developer ID + notarize** (sign every nested `.so`/`.dylib`, hardened runtime). MAS is a stretch goal. | `architecture-patterns/python-sidecar-in-mac-app.md` |
| R4 | Canvas architecture | Single `@Observable @MainActor CanvasStore` in **world coordinates** + a `Viewport` camera (one `scaleEffect`+`offset`, not `ScrollView`/`NSScrollView`). **Hybrid render**: `Canvas` layer for edges/LOD + viewport-culled `ForEach` of interactive node views (quadtree index). Agent applies small `Mutation` commands on `@MainActor`, coalesced per frame in `withAnimation`. | `canvas/infinite-canvas-swiftui.md` |
| R5 | Menu bar + window in one app | `WindowGroup(id:"main")` + `MenuBarExtra(...).menuBarExtraStyle(.window)` together. Launch as `.accessory`, promote to `.regular` when a window shows; `applicationShouldTerminateWhenLastWindowClosed → false` keeps the menu bar (and sidecar) alive. | `apple-platform/menu-bar-app.md` |
| R6 | Liquid Glass | API **unchanged in macOS 27** (still 26.0+): `glassEffect`, `GlassEffectContainer`, `glassEffectID`, `.interactive()`. Glass on **chrome only**, never canvas content; batch in few `GlassEffectContainer`s; test against the new system **translucency/intensity slider**. | `apple-platform/liquid-glass-swiftui.md` |
| R7 | Codex Spark identity | = **OpenAI GPT‑5.3‑Codex‑Spark** (announced 2026‑02‑12, Cerebras, >1000 t/s) — but **research-preview, ChatGPT Pro only, NO public API yet**. Can't build on it today. | `models/realtime-fast-models.md` |
| R8 | Real-time routing | Hot path (live edits): **Groq small model** (~950 t/s) or **Cerebras**; reasoning edits: **Claude Haiku 4.5**; offline/private: **Foundation Models on-device**; heavy multi-step: **Claude Code via MCP**. Re-check Codex‑Spark API status periodically. | `models/realtime-fast-models.md` |

## 2026-06-24 — Round 2 decisions (data source + scope)

| # | Decision | Choice | Notes |
|---|----------|--------|-------|
| D10 | Data source (OQ1 ✅) | **Download the actual videos** from YouTube/TikTok/Instagram, analyze locally | No stats API. Media-pipeline app, not an analytics-API client. |
| D11 | Platforms | **YouTube + TikTok + Instagram** at launch | Download via `yt-dlp`; per-platform auth/ToS caveats apply |
| D12 | Local pipeline | **`yt-dlp` (download) → PySceneDetect (scene split) → ffmpeg/PyAV (keyframes) → VLM** | Runs in the Python sidecar |
| D13 | VLM routing | On-device **Foundation Models v3** (image-in-prompt) for local/free scene description; **Claude vision** models for heavier/better analysis | See `models/realtime-fast-models.md` + `ai-on-device/foundation-models-v3.md` |
| D14 | MCP topology | **Two sidecar consumers, one shared SQLite store.** Claude Code launches its own stdio MCP instance (owns that pipe). The app spawns its OWN instance for the real-time router / live canvas. They do NOT share a stdout pipe. | Refines R1 — see below |

### R1 (revised) — live-update channel
The "reuse the stdio pipe" pattern applies ONLY to the **app-spawned** sidecar instance (the app
owns that `Process`'s stdout → `AsyncStream` → `@MainActor`). The **Claude-Code-spawned** instance's
stdout belongs to Claude Code. Cross-instance liveness = both write the shared **SQLite (WAL)**
store; to push Claude Code's mutations into the live UI without polling, the Claude-Code instance
notifies the app over a small **local socket the app hosts** (or the app re-fetches on a debounce).
Skeleton implements the app-owned path first; the hosted-socket notify path is a TODO.

## Open questions (still need answers)

- **OQ5 — Auth/account model.** Single local user, or accounts + cloud sync?
- **OQ7 — Storage footprint.** Downloaded videos are large; where do they live, retention/eviction
  policy, and do we keep originals or only keyframes + analysis after processing?
- **OQ8 — Heavy-VLM provider.** Folded into D16 (dynamic routing) — see Round 3.

## 2026-06-24 — Round 3 decisions (post-feasibility review)

Driven by `docs/FEASIBILITY.md`. Where the analyst recommendation and the owner's call differ,
the **owner's call wins and is recorded here as authoritative.**

| # | Decision | Choice | Notes |
|---|----------|--------|-------|
| D15 | Real-time architecture | **ADOPT the two-engine split; the app owns the frame clock.** Models only ever propose **batched** canvas ops; the `@MainActor` renderer animates them in at 120 Hz. Retire "real-time via Claude Code over MCP." | T1 = single fast-model call (no agent loop, no MCP); T2 = Claude Agent SDK batched; T3 = Claude Code/MCP async. See FEASIBILITY §1. |
| D15a | Agent tool surface | **Expose `apply_canvas_ops(ops=[...])` BATCH only** to the agent; do NOT expose single-node mutators. One user intent → one op-list. | Enforced at tool surface + system prompt |
| D16 | Model / VLM routing (OQ8 ✅, Q2) | **KEEP OPEN — dynamic, pluggable router + eval harness.** Continuously balance on-device **Foundation Models v3** vs. sending frames to **Claude / Gemini / GPT**, choosing best-data-in-shortest-time per task. No fixed default. **PySceneDetect always runs for scene separation** regardless of routing. | Build a benchmark/eval harness so the router is data-driven, not guessed |
| D17 | Heavy agent (Q3) | **v1 = every user via their OWN Claude Code over MCP.** Keep the agent/model layer behind an interface so **in-app Claude** (Anthropic Swift package) can be added later. In-app path **deferred** for now. | Simplifies v1; revisits OQ6 later |
| D18 | Data posture (OQ1 ✅, Q1) | **URL download is the first-class, MARKETED hero** — paste a YouTube/TikTok/Instagram URL → download → analyze. | ⚠️ **Legal risk acknowledged & accepted by product owner** (DMCA §1201 per *Cordova v. Huneault*; platform ToS). Overrides FEASIBILITY's BYO-file recommendation. **Mitigations retained:** 720p cap, analyze-then-evict source media, auto-update yt-dlp + honest "platform changed" fallback UX, no bundled credentials. **Get counsel before public launch.** |
| D19 | Build focus (Q4) | **FRONTEND-FIRST.** Build the SwiftUI app (infinite canvas, CanvasOp bus + `@MainActor` store, Liquid Glass chrome, menu bar, Home) against **mock/in-memory op sources**, before any backend logic. | Backend (Python pipeline + MCP server internals) owned by **co-founder**, in parallel. Await co-founder's backend/architecture spec before wiring the real backend. First milestone not yet fixed. |
| D14′ | Writer topology (revises D14) | **Collapse to ONE live writer** — the app-spawned sidecar owns the live `stdout → AsyncStream → @MainActor` pipe. The Claude-Code-spawned instance is a **non-real-time** writer: persists to SQLite + pings the app over an authenticated `127.0.0.1` socket to re-fetch through the same `apply()` funnel. | Preserves the single-serialization correctness proof. See FEASIBILITY §1.4. |
| D7′ | Codex Spark (revises D7/R7) | **Watchlist only — not required to ship, do not architect around it.** No public API, text-only (can't see keyframes), unreliable structured output. WWDC 2026's on-device MLX/AFM 3 fast lane replaces its intended role. | Re-check monthly; structured-output reliability is the real gate |

### Toolchain discrepancy to reconcile (D3)
Research says **Xcode 27 beta ships Swift 6.4 / macOS 27 SDK**; the CLI here reports **Swift 6.3.2 /
`macosx28`**. Not silently corrected. **Action:** confirm with co-founder which Xcode/toolchain we
actually target (assume latest Xcode 27 beta + macOS 27 SDK for the SwiftUI build unless told otherwise).

### Frontend-first integration contract
Because the frontend leads, the **frontend defines the interface the backend must satisfy**: the
typed `CanvasOp` schema + the read/`apply_canvas_ops` tool surface. The app builds against a **mock
op source** implementing that contract; the co-founder's backend later conforms to it. Capture the
backend contract in a new `docs/BACKEND_INTEGRATION.md` when the co-founder's spec arrives.

## Open questions (still need answers)

- **OQ5 — Auth/account model.** Single local user, or accounts + cloud sync?
- **OQ7 — Storage footprint / retention.** Confirm 720p cap + analyze-then-evict default.
- **OQ9 — Toolchain target.** Reconcile Swift 6.4 / macOS 27 SDK vs the installed 6.3.2 / `macosx28`.
- **OQ10 — First milestone.** To be set after the co-founder's backend/architecture spec lands.

## 2026-06-24 — Round 4: ARCHITECTURE PIVOT (canonical; supersedes earlier UI/transport/DB choices)

New canonical architecture (per the architecture diagram). The **Mac App** contains THREE
components; an external **Agent (Claude)** triggers tools; the **Database (Postgres/Aiven)** is shared
by all three.

```
 Agent (Claude) ──trigger tools──► Comms Service (Python) [MCP(HTTP) + Canvas Backend]
                                      │  pings ▲         │ updates data
                                      ▼        │         ▼
                                 Canvas UI ◄────┘     Database (Postgres/Aiven)
                                 (Next.js+tldraw)  ▲      ▲
                                      │ loads data │      │ updates data
                                      └────────────┘   Analysis Worker (Python)
                                                          ▲ triggers (from Comms Service)
```

| # | Decision | Choice | Supersedes |
|---|----------|--------|-----------|
| D20 | Canvas UI stack | **Next.js (App Router) + tldraw SDK**, in a **SwiftUI + WKWebView** shell; runs as web **and** desktop. App-level state via **Zustand** (default; Jotai acceptable). | D2, R4, D19 (SwiftUI-native canvas) |
| D21 | Why not SwiftUI | No infinite-canvas primitives in SwiftUI; tldraw ships camera/zoom/selection/minimap/snapping OOTB. | — |
| D22 | MCP transport | **Streamable HTTP** | D4 (stdio) |
| D23 | Database | **Postgres via Aiven** (managed); all 3 components use the connection URL + password. | R2, D14′ (shared SQLite/WAL) |
| D24 | Components | (1) **Canvas UI** (Next.js+tldraw, ours), (2) **Comms Service** (Python = MCP-over-HTTP + Canvas Backend, co-founder), (3) **Analysis Worker** (Python, co-founder). | two-engine/sidecar framing |
| D25 | Data flow | Canvas UI **loads** from Postgres (via Next.js server routes — browser can't do raw PG); Comms Service **pings** Canvas UI (real-time) + **updates** Postgres + **triggers** Analysis Worker; Analysis Worker **updates** Postgres. | R1/D14′ stdio notify path |
| D26 | Current build scope | **Canvas UI ONLY.** Comms Service + Analysis Worker are the co-founder's. | narrows D19 |

**Carry-over still valid:** the two-engine *idea* (app owns the frame clock; agent proposes **batched**
ops the UI animates in) now maps onto tldraw — remote ops applied via the tldraw store. The
`CanvasOp`/batch contract (D15a, `BACKEND_INTEGRATION.md`) still governs how the Comms Service pings
the Canvas UI; it just targets tldraw shapes instead of a SwiftUI store.

**Now-stale stubs (co-founder to update, not us):** `mcp-server/` is stdio+SQLite → becomes the
Comms Service on **HTTP+Postgres**; `schema.sql`/`DATA_MODEL.md` move from SQLite to Postgres
(schema is largely portable). Left in place, flagged, not deleted.

### Round 4 open questions
- **OQ11 — Canvas op/event channel.** How the Comms Service "pings" the Canvas UI in real time
  (WebSocket vs SSE) and the op/event payload shape. (Research in progress.)
- **OQ12 — Next.js packaging in WKWebView.** Local Node server bundled vs `output: 'export'` static
  + custom scheme — driven by whether DB reads happen in Next.js server routes or via Comms Service HTTP.
- **OQ13 — tldraw license.** SDK license/watermark tier for a commercial product.
- **OQ6 — Anthropic-via-Foundation-Models.** WWDC 2026: Anthropic is shipping a Swift package for
  the Foundation Models framework (Claude as a `LanguageModelSession` provider). Decide: use Claude
  *through* FM for app-level uniformity vs. direct Anthropic SDK / MCP-Claude-Code when we need
  Anthropic-specific features (prompt caching, batches, extended thinking, server tools). Leaning:
  **both** — FM-provider for in-app quick tasks, MCP/Claude Code for the agentic heavy lifting.

## 2026-06-25 — Creator Room (3D diorama hero)

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| D27 | Creator Room concept | An isometric clay-render **diorama** of the creator's world, on the **Home screen** (full-white background). **Fixed skeleton + variable payload**: geometry/zones/camera/lighting constant; only per-zone objects change. Zones = library / content / referral / style / companions. | Per the build brief; one component → infinite personalized rooms. |
| D28 | Render path | A **self-contained three.js HTML document** run in a **sandboxed `<iframe srcdoc>`**. NOT React Three Fiber baked into the bundle. | R3F can't be transpiled/mounted at runtime in a **static export**; a self-contained doc *is* runnable generated code and stays isolated from our origin. Keeps three.js out of the Next bundle (loaded via jsDelivr importmap). |
| D29 | Two render sources, one iframe | **Procedural** renderer (`lib/creatorRoom.ts → buildRoomDoc`) is the instant, offline, deterministic default **and** the fallback; **live Claude generation** swaps in a bespoke doc when available. | Brief's `code_only` (deterministic, editable) for the product + `image_then_code`-style hero. Canvas always works with no backend. |
| D30 | Generation lives in the Comms Service | `POST /api/creator-room/generate` on `src/python-service` (FastAPI) calls **Claude Opus 4.8** (adaptive thinking, streamed) to write the room doc. UI reaches it via `NEXT_PUBLIC_COMMS_API_URL`; 503 → procedural fallback. | Consistent with the static-export decision (D22/D24, webview-shell doc): the client never calls Anthropic/Postgres directly. First concrete Comms Service endpoint. |
| D31 | Scope | **Home screen only** for now (intake form + hero). Per-project rooms deferred. | Chosen with the user; keeps v1 focused. |

## 2026-06-25 — Creator Room: IMAGE mode is the default

Pivot after seeing the procedural 3D ship as a greybox vs. the reference clay render.

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| D32 | Default mode | **Image** (a clay-render diorama PNG), with the 3D procedural/generated room as a secondary **toggle**. | A rendered image matches the reference style 1:1 (character/avatar, soft clay, full scene); hand-coded primitives can't. |
| D33 | Image pipeline | Profile → **deterministic image prompt** (faithful to the brief's Prompt A; optional Claude refine when ANTHROPIC_API_KEY is set) → **OpenAI `gpt-image-1`** → data-URL PNG shown as the hero. `POST /api/creator-room/image`. | Anthropic can't output images; gpt-image-1 is best at this cozy clay-iso style + character fidelity. Verified end-to-end (adapts per profile: shooter→rig, pet, palette, lighting). |
| D34 | Default visual | A bundled **own-generated** sample (`public/creator-room/sample.png`, made with gpt-image-1) shown **blurred behind a "Generate" CTA** until a real image is rendered. | Clean (no third-party/annotated art), conveys the style instantly, sets the generate expectation. Needs only `OPENAI_API_KEY` (image mode is independent of Anthropic). |
