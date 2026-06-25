# Integration Notes — our planning vs. the canonical repo design

_Last updated: 2026-06-24._ Written when our research/frontend work was merged into
`team-avlana/sunstead-hack` (which already had the team backend skeleton). **The team's
`docs/architecture.md` and `src/database/schema.sql` are canonical**; where our earlier docs/scaffold
differ, this file records the divergence and the reconciliation action. Nothing here is "wrong" — it's
the to-do list to make the frontend match the canonical backend.

## Already aligned ✅
- **Agent = the user's own Claude client** over MCP (canonical) == our D17.
- **MCP over HTTP** (canonical) == our D22 (Streamable HTTP).
- **Postgres single source of truth** (canonical) == our D23 (Aiven Postgres).
- **Component layout `src/<component>/`** with `python-service`, `analysis-worker`, `canvas-ui`,
  `mac-app` (canonical) — our dirs were moved to match.

## Divergences to reconcile 🔧

| # | Topic | Canonical (team) | Our scaffold/docs | Action |
|---|-------|------------------|-------------------|--------|
| 1 | **Canvas mutability** | **Read-only.** Renders typed **artifacts**; never authors edits. | Editable tldraw canvas + `attachOutboundSync()` shipping user edits back. | **Make `canvas-ui` render-only:** drop outbound sync; treat the canvas as a view over `artifacts`. (Keep editing only if the team later wants it.) |
| 2 | **Realtime channel** | **Websocket** carrying a **change-signal only** (never data); canvas then re-pulls. | **SSE carrying the ops** themselves. | Switch `lib/realtime.ts` to a **websocket** that receives "artifact X changed" → trigger a re-pull. (Our SSE research still useful, but align to the team's websocket.) |
| 3 | **Data model** | `projects, creators, videos(+metrics), shots, style_profiles, artifacts(typed payload + element ids), memory` (Postgres, soft-delete, triggers). | `docs/DATA_MODEL.md` (SQLite: creator/video/scene/keyframe/analysis/canvas_node/canvas_edge). | **`src/database/schema.sql` is canonical.** Mark `docs/DATA_MODEL.md` superseded; the canvas renders `artifacts` of type `storyboard \| shot_list \| idea_board \| script_doc \| mood_board \| diagram`. |
| 4 | **Canvas data reads** | "canvas-ui reads its data **directly from Postgres**." | Our research: a browser/WebView **cannot** open raw Postgres; reads must go over HTTP. | **Open question for the team:** "direct" must mean either (a) `python-service` exposes read HTTP endpoints the canvas fetches (keeps `canvas-ui` a static export — recommended), or (b) `canvas-ui` runs its own Next.js server with a PG client (forces a bundled Node server). Pick (a) unless there's a reason for (b). See `knowledge-base/architecture-patterns/webview-shell-and-data-path.md` §4. |
| 5 | **Agent tool surface** | Tools: `analyze`, save/get `memory`, **create/update `artifact`** (addressable by `element_id`), get analysis results. | `BACKEND_INTEGRATION.md` proposed `apply_canvas_ops(ops=[...])` over raw tldraw shapes. | Reframe: the agent edits **artifacts** (typed), not tldraw shapes; `canvas-ui` maps `artifacts → tldraw shapes` for rendering. Update `BACKEND_INTEGRATION.md` accordingly. |
| 6 | **Backend service** | `src/python-service` (FastMCP/uvicorn HTTP). | Root `mcp-server/` (FastMCP **stdio + SQLite**). | `mcp-server/` is **superseded** (banner added). Canonical = `src/python-service`. |
| 7 | **DB credentials** | Single **shared config file** read at startup by all components. | Our docs assumed per-process env/secret. | Adopt the team's shared config-file approach for the demo. |

## Net effect on `src/canvas-ui`
The scaffold is a correct, runnable tldraw-v5 + Next.js foundation, but to match canonical it should
become an **artifact renderer**: load `artifacts` (+ positions) for a project, map each to a tldraw
shape, and **re-pull on a websocket change-signal** — instead of an editable board with outbound sync
and an SSE op stream. The `mergeRemoteChanges` no-echo machinery still applies when the canvas writes
the re-pulled artifacts into the store. **Hold these changes until the team confirms** (per "don't
implement more code yet").

## Still-valuable, unchanged
`knowledge-base/` (all of it), `docs/FEASIBILITY.md` (near-real-time analysis, Apple-tools survey,
pipeline cost/caveats), and the tldraw-v5 + WebView-shell reference docs remain accurate and useful.

## Reconciliation status — 2026-06-25 (canvas ↔ canonical backend)
Implemented on `feature/rainy-canvas-mcp-integration` (see `docs/RUNNING.md`):
- **#2 Realtime → websocket.** `lib/realtime.ts` now opens `/ws` and treats messages as
  *change-signals only*, re-pulling artifacts from the read API (+ a poll fallback). SSE scaffold retired.
- **#4 Canvas reads.** Resolved as **option (a)**: `python-service` exposes a read HTTP API
  (`/api/projects`, `/api/projects/{id}`, `/api/artifacts/{id}`, `/api/videos/{id}`, `/frames/...`),
  so `canvas-ui` stays a static export. `lib/api.ts` + `lib/backendCanvas.ts` consume it.
- **#1/#3/#5 Artifact rendering.** The canvas maps typed artifacts → tldraw shapes
  (`type:'video'` → the new **Video Block**; others → text cards), id-namespaced so reconciliation
  never clobbers user shapes. Editing is preserved for now (not yet forced read-only).
- **Video blocks** are `artifacts(type='video')` with `payload.video_id`; the read API joins the
  live analysis (`video_view.derive_video`). Cross-process change-signals use Postgres
  `LISTEN/NOTIFY` (no DDL on the shared DB).

Still open: the `mac-app` static-export packaging.

## Reconciliation status — 2026-06-25 (canvas → backend writes: full CRUD)
**Decision reversed: the canvas is now intentionally _editable_ (bidirectional), not read-only (#1).**
The product wants users to edit on the canvas and have it persist, with the agent and the canvas as
co-equal writers of the same `artifacts`. Implemented:
- **Write HTTP API.** `python-service` now exposes the write half alongside the reads:
  `POST /api/projects/{id}/artifacts` (create) and `PUT`/`DELETE /api/artifacts/{id}`. `PUT` accepts
  `position`, `title`, whole-`payload`, **`payload_patch`** (shallow-merge), **`element_patch`**
  (merge one `payload.elements[]` by id), and **`element_remove`** (drop one element). Every write
  bumps `version` and broadcasts the same WS change-signal as the MCP tools.
- **Outbound sync.** `lib/backendSync.ts` (`attachBackendSync`) listens for genuine *user* edits to
  backend shapes and maps them to those writes: move→`position`/`element_patch{x,y}`,
  resize→`element_patch{w,h}`, text→`payload_patch{content}` (top-level) or structured
  `element_patch{format,title,subtitle,body}` (frame child — see below), video view→`{view}`,
  frame rename→`payload_patch{label}`+`title`, delete→`DELETE`/`element_remove`, and create→`POST`
  then "adopt" the shape (id map) so reconciliation doesn't duplicate it. Debounced + coalesced.
- **No-clobber guards.** The reconcile loop (`syncBackendProject`) skips overwriting content that's
  being edited / was just edited (content-dirty grace + the active editing shape), and won't
  re-create an artifact the user just deleted (pending-delete) — so a write survives its own
  round-trip and the 6s poll.
- **Structured text + `block_normalize`.** Because `db.update_artifact` runs
  `block_normalize.normalize_payload` (structured `{format,title,subtitle,body}` parts win and
  rebuild `content`), a frame's text *element* is written structurally, not as raw `content`, or the
  normalizer would rebuild it from stale parts. Top-level text artifacts aren't normalized, so they
  keep raw `content`. Kept in sync with `canvas-ui/lib/blockTypes.ts`.
- **Verified** end-to-end against the live DB: create / payload_patch / element_patch (merge) /
  position / element_remove / delete, plus the structured-text round-trip and its counter-proof.

Net: `docs/architecture.md` still describes the canvas as "read-only" — that is now **superseded**
for artifact authoring; the canvas is a bidirectional view over `artifacts`.

## Reconciliation status — 2026-06-25 (image blocks: storyboard / shot-list visualisation)
The block taxonomy documented an `image` element (`{src, frame_id, caption?}`) and the backend already
emitted it (`generate_storyboard_frame` → an artifact with `src='/api/storyboard/{id}'`; past-video
storyboards use `src='/frames/{id}'`), but the canvas had **no image renderer** — `backendCanvas.expandArtifact`
only branched on `video`, so image elements fell through to the text card and rendered empty. Implemented
the missing half so storyboard and shot-list flows are visual:
- **Image block.** New tldraw shape `image-block` (`components/ImageBlockShape.tsx` + `ImageBlock.module.css`),
  taxonomy in `lib/blockTypes.ts` (`IMAGE_BLOCK` / `ImageData`), registered in `CanvasWorkspace`. Renders the
  image with a caption bar + shot-type badge, a loading skeleton, and a broken-frame fallback (frames live on
  the worker host and can 404). Mirrors the Video block (canEdit=false, resizeBox, delete/grip chrome).
- **Rendering + reconcile.** `backendCanvas` maps `type:'image'` elements onto the shape, resolving `src`
  through `resolveAssetUrl` (relative `/frames/...` and `/api/storyboard/...` → absolute; `data:`/`http`
  pass through), with caption falling back through `caption`/`concept`/`label`. Reconcile patches
  `src`/`caption`/`shotType` but not `w`/`h`, so a user resize survives a re-pull.
- **Outbound sync.** `backendSync.buildPatch` persists image move/resize as `element_patch {x,y,w,h}` (a video's
  size is view-derived, so only text + image carry `w/h`); image children pin out of frame auto-layout like
  any moved block.
- **Shot lists** have no dedicated MCP output — they're agent-authored frames built from `get_video_shots`
  (frame_id + shot_type + timecode + per-shot analysis): image blocks paired with `title-sub` text.
- **Verified** end-to-end against the live DB: a demo project ("POV: the feature ships — full prepro") with
  research/ideation/script/storyboard/shot-list frames; image elements round-trip intact through
  `create_artifact`/`block_normalize`, the read API enriches the video element, and every referenced
  `/frames/{id}` returns `200 image/jpeg`.
