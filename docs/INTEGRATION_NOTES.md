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
