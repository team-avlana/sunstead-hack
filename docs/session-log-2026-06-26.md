# Session Log — 2026-06-26

Work session spanning ~5 hours on the **Rainey** preproduction canvas.
5 commits landed, plus uncommitted in-progress work across 9 additional files.

---

## 1. Architecture & Strategy

### UGC Agency Review Loop — scoped and decided (D39–D42)

- **Decision D39:** rescoped the product to serve UGC agencies, not just solo creators.
  Added a second top-level workflow: **Brief → Deliver → Review → Coach**.
- **Decision D40:** review output is ordinary canvas frames/blocks — no new shapes, no scoring service,
  no extra tables. The agent reasons over the brief + reference + delivery analyses and writes the
  verdict as text using existing `create_artifact`.
- **Decision D41:** concept test runs **local-only** (Postgres localhost, zero Aiven DDL) so the loop
  can be proved before infra cost is incurred. Degrades honestly when IG/TikTok yt-dlp is blocked.
- **Decision D42:** reference ingestion (IG/TikTok via yt-dlp) identified as the known blocker;
  failing gracefully is a first-class requirement.
- Wrote full design document: `docs/ugc-review-loop.md` (106 lines) covering the Brief/Deliver/Review
  frame schema, output criteria, the coaching note format, and the improvement-over-time comparison logic.

---

## 2. Python Service — Agent SDK, Dev Bus, Review Workflow

### Agent bridge (`agent_bridge.py`)

- **Built** `agent_bridge.py` from scratch: hosts a Claude Agent SDK assistant over a WebSocket.
  Company-owned credential — end users never bring Claude creds.
- The assistant drives the same local MCP tools as Claude Code; output lands on the canvas via
  Postgres → `/ws` change-signal (no new data path).
- **Provider routing:** Anthropic vs Azure Foundry selected by global env config (`config.py` `AgentConfig`).
  Drops inherited `ANTHROPIC_FOUNDRY_*` env vars before constructing the Foundry client
  (they are mutually exclusive with explicit `base_url`).
- Token streaming: partial-mode (`RAINY_AGENT_PARTIAL=1`) forwards `StreamEvent` deltas in real-time;
  block-fallback consolidates the `AssistantMessage` when streaming is off.
- MCP tool surface confirmed up front on every connect so the panel's tool-count pill shows immediately
  without waiting for the first message.

### Dev activity bus (`dev_events.py`)

- **Built** in-memory event bus + WebSocket fan-out of timed spans and forwarded logs.
- Env-gated (`RAINY_DEV_LOGS`): a no-op in production, zero overhead when disabled.
- Used by the new `DevActivityPanel` in the canvas to give a live view of service internals during
  development.

### UGC review workflow instructions (`review_workflow.py`)

- **Built** `UGC_REVIEW_GUIDE` — a 138-line rubric injected into MCP server instructions so **both**
  Claude Code *and* the embedded Rainey agent learn the review loop without separate prompting.
- Covers: Brief frame anatomy, Delivery frame anatomy, Review procedure (hook, tone, pacing,
  constraints, missing, strengths), Coaching note format, and the improvement-over-time comparison.

### New `compare_components` MCP tool (`tools/review.py`) — uncommitted

- **Built** `compare_components(source_video_id, target)` — gathers a source video's compact
  analysis (metrics + per-shot OCR) and a target (a brief frame's text blocks + reference analysis,
  or another video's analysis) in a single call.
- This is a **data-gathering tool only** — the verdict, missing-list, and coaching note are
  the agent's reasoning, keeping the brain in the model.
- Registered in `server.py` alongside the existing tools.
- **Added video-vs-video comparison path** to the review workflow guide: when the user picks two
  videos instead of a video + brief, the rubric produces a diff frame (hook, structure, tone, pacing)
  leading with what differs and what one has that the other is missing.

### Routing & config

- `config.py` (`AgentConfig`): centralised model, temperature, and provider env routing.
- `routes_api.py`: `/agent` WebSocket endpoint, `/dev/events` SSE endpoint.
- `worker.py` and `notify.py`: extended to carry analysis stage in `pg_notify_change` payloads so
  the canvas updates live over the WebSocket instead of polling.

---

## 3. Persistent Conversation Threads

### Schema (`schema.sql` + migration `002_conversations.sql`)

- **New tables:** `conversations` (UUID PK, client-assigned) + `conversation_messages`
  (`role CHECK IN ('user','assistant')`, `content`, `created_at`).
- `conversations.id` is client-assigned so the same thread survives page refreshes with no
  server round-trip to create it.
- `ON DELETE CASCADE` from conversation → messages; `SET NULL` from project → conversation
  (conversations outlive a deleted project).
- Migration file written: `src/database/migrations/002_conversations.sql` (`IF NOT EXISTS`-safe).

### DB layer (`db.py`)

- `get_or_create_conversation(thread_id)` — upsert with `ON CONFLICT DO NOTHING`.
- `load_conversation_messages(thread_id, limit=60)` — returns last 60 messages, oldest-first.
- `append_conversation_messages(thread_id, messages)` — batch insert + bumps `updated_at`.

### Agent bridge wiring (`agent_bridge.py`) — uncommitted

- On WebSocket connect: loads prior history before accepting the socket, then emits a `history`
  event (message list) immediately — so the UI restores messages *before* the panel shows as connected.
- History is prepended to the system prompt (up to 40 messages, 3000 chars each) under a
  `[PRIOR CONVERSATION — restored from transcript]` block.
- After each assistant turn, persists `{role: user, content}` + `{role: assistant, content}` to Postgres.
- UUID validation: only accepts well-formed UUIDs for `thread_id`; silently ignores garbage.
- Errors in persistence are logged as warnings and do not kill the session.

### Canvas panel (`AgentPanel.tsx`) — uncommitted

- Thread ID persisted in `localStorage` under `rainy:threadId`; initialised to a fresh UUID on
  first visit, restored on reload.
- `initialThreadId()` is SSR-safe (falls back to `crypto.randomUUID()` when `window` is absent).
- WebSocket URL extended: `?model=…&thread_id=…`; effect re-runs on either change.
- `history` WebSocket message dispatched to reducer → entries pre-populated before `ready` fires.
- **"New conversation" button** added to the panel header (pencil-on-document icon) — generates a
  fresh UUID, persists it, and reconnects, clearing the transcript.
- CSS: `.cc-new-chat` button style added (light + dark modes, matches `.cc-collapse` sizing).

---

## 4. Canvas UI — Agent Panel, Dev Panel, Camera, Error Boundaries

### Agent / Rainey panel (`AgentPanel.tsx`, `RightPanel.tsx`)

- **Built** the streaming chat panel from scratch (463-line component).
- Reducer-driven state machine: `idle | waiting | thinking | tool | writing` phases with a
  live entry for in-flight streaming.
- Tool calls shown inline with a spinner; status line reflects current phase.
- Reconnects with exponential backoff; `connected` pill tracks WebSocket state.
- Model selector persisted to `localStorage` (`rainy:agentModel`).
- `RightPanel.tsx` added: tab switcher between the Rainey agent panel and the existing Claude Code
  terminal panel, stored in Zustand.

### Dev Activity Panel (`DevActivityPanel.tsx`)

- Live SSE feed of spans/logs from the Python service `/dev/events`.
- Env-gated: only mounts when `NEXT_PUBLIC_RAINY_DEV_PANEL=1`.
- Ships inert in production — no overhead, no bundle growth.

### Camera persistence (`camera.ts`)

- `camera.ts` centralised as a single source of truth for camera management:
  - Per-project camera persistence (saves/restores pan + zoom per project ID).
  - `fitToVisible()` — fits the viewport to all visible shapes.
  - Reflow stability: prevents camera jumps on shape additions.

### Error boundaries

- `app/error.tsx`: route-level error boundary — shows a friendly error card instead of a blank canvas.
- `app/global-error.tsx`: root-level boundary for unrecoverable errors, matching the app's dark/light theme.

### Grip snapping (`ShapeChrome.tsx`)

- Grip-drag now routes through tldraw's snap manager — alignment guides and nudge work the same
  way as the native body-drag.

---

## 5. Analysis Worker — Resilience & Live Notifications

### Resilient yt-dlp downloads (`download.py`)

- **stderr capture:** surfaces a real failure reason on the canvas card instead of a bare exit code.
- **Retry with backoff:** IG/TikTok rate-limits mid-session; yt-dlp resumes partial `.part` files
  so retries are safe. Configurable max retries + delay.

### Live stage notifications (`worker.py`, `notify.py`, `db.py`)

- `notify_change` now carries the current analysis stage in its payload.
- Canvas receives stage updates over the WebSocket → VideoBlockShape re-renders without polling
  `GET /api/videos/{id}`.

---

## 6. VideoBlockShape — UI Cleanup

### Removed hook strength bar (committed)

- Removed the 10-pip hook-strength bar and `hookHead` wrapper from the Hook component.
- Hook section now shows label + format + quote text only — simpler, less visual noise.

### Replaced video summary with scene thumbnails (committed)

- Default view no longer shows the AI-generated video summary text block.
- Shows scene thumbnail strip instead — more scannable, matches the rest of the card design.

---

## 7. Video View — Junk Tag Filtering

### `_is_junk()` helper and tag cleanup (`video_view.py`) — uncommitted

- **New helper `_is_junk(tag)`:** rejects tags whose lowercase value starts with any of:
  `unknown`, `undetermined`, `indeterminate`, `n/a`, `none`, `unclear`,
  `not applicable`, `not determined`, `unclassified`.
- Applied to: `topic`, `scriptedness`, `tone_voice`, `language`, and scene tags
  (`shot_type`, `roll`, `composition`).
- Before this, the LLM returning `"unknown"` for an unclassifiable field produced a visible chip
  on the VideoBlock card. Now those fall off silently.

---

## 8. Bug Fixes & Stability

| Area | Fix |
|---|---|
| yt-dlp downloads | Bare exit-code error → stderr capture + retry with backoff |
| Foundry env conflict | Drop `ANTHROPIC_FOUNDRY_*` before constructing Foundry client (mutually exclusive with `base_url`) |
| Camera reflow | Centralised `camera.ts` prevents viewport jumps when shapes are added |
| Canvas blank on crash | Route + root error boundaries replace the blank white canvas on unhandled errors |
| Agent session loss on reload | Conversation persisted to Postgres, restored on reconnect via `history` event |
| Junk chips on video cards | `_is_junk()` filters LLM `"unknown"`/`"n/a"` field values before they render as tags |
| Agent turn persistence silent failure | Errors caught + logged as warnings; session continues |
| Thread UUID injection | Validates UUID client input before use as PK — ignores malformed values |

---

## 9. Files Created / Significantly Changed

| File | Status | Description |
|---|---|---|
| `docs/ugc-review-loop.md` | new | Full design doc for the UGC review loop |
| `docs/DECISIONS.md` | updated | D39–D42 added |
| `src/python-service/agent_bridge.py` | new (320 → 395 lines) | Agent SDK WebSocket host + conversation persistence |
| `src/python-service/dev_events.py` | new | In-memory event bus + SSE fan-out |
| `src/python-service/review_workflow.py` | new | UGC_REVIEW_GUIDE injected into MCP instructions |
| `src/python-service/tools/review.py` | new | `compare_components` MCP tool |
| `src/python-service/config.py` | new | Centralised AgentConfig + provider routing |
| `src/python-service/db.py` | extended | Conversation CRUD + storyboard additions |
| `src/python-service/server.py` | updated | Register review tool, wire dev events |
| `src/python-service/routes_api.py` | updated | `/agent` WS + `/dev/events` SSE routes |
| `src/python-service/worker.py` | updated | Stage notifications in analysis pipeline |
| `src/python-service/notify.py` | updated | Stage payload in pg_notify_change |
| `src/database/schema.sql` | updated | `conversations` + `conversation_messages` tables |
| `src/database/migrations/002_conversations.sql` | new | Additive migration for existing DBs |
| `src/canvas-ui/components/AgentPanel.tsx` | new (463 lines) | Streaming Rainey chat + thread persistence |
| `src/canvas-ui/components/RightPanel.tsx` | new | Tab switcher: Rainey vs Claude Code |
| `src/canvas-ui/components/DevActivityPanel.tsx` | new | Dev SSE span viewer |
| `src/canvas-ui/lib/camera.ts` | new | Per-project camera persistence + fit-to-visible |
| `src/canvas-ui/lib/devEvents.ts` | new | SSE client for dev activity |
| `src/canvas-ui/lib/backendSync.ts` | extended | Realtime + canvas sync refinements |
| `src/canvas-ui/app/error.tsx` | new | Route error boundary |
| `src/canvas-ui/app/global-error.tsx` | new | Root error boundary |
| `src/canvas-ui/components/VideoBlockShape.tsx` | updated | Scene thumbnails, removed summary + hook bar |
| `src/canvas-ui/components/ShapeChrome.tsx` | updated | Snap-manager grip drag |
| `src/canvas-ui/app/globals.css` | updated | Agent panel + new-chat button styles |
| `src/analysis-worker/download.py` | updated | stderr capture + retry with backoff |
| `src/analysis-worker/analyze_llm.py` | updated | Stage notification |
| `src/analysis-worker/profile_llm.py` | updated | Stage notification |
| `src/python-service/video_view.py` | updated | `_is_junk()` tag filter |
