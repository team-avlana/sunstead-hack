# canvas-ui

The **infinite canvas** — Next.js (App Router) + **tldraw v5** — built to run **both** as a plain web
app and inside the macOS **SwiftUI + WKWebView** shell (`../mac-app`).

> ⚠️ **Reconcile with the canonical design before building further** (see `../../docs/INTEGRATION_NOTES.md`).
> The team architecture (`../../docs/architecture.md`) makes this canvas **READ-ONLY**: it renders typed
> **artifacts** from Postgres and **re-pulls** when the `python-service` sends a **websocket
> change-signal**. The current scaffold is editable with an SSE op channel + outbound sync — a
> divergence to resolve (drop outbound sync, render artifacts, switch realtime to the websocket ping).

## Run it ✅

```bash
cd src/canvas-ui
npm install
npm run dev          # http://localhost:3000  — sidebar + tldraw canvas + the Rainey companion
```

With no backend configured, a **mock-comms demo** drops a few agent-authored nodes onto the canvas
~1s after load — the agent→canvas path working end to end against the real remote-ops layer.

```bash
npm run typecheck    # tsc --noEmit
npm run build        # static export to ./out (what the WebView shell bundles; also the web deploy)
```

## Layout (this package)

- **`app/`** — App Router. `page.tsx` (server) → `CanvasClient` (client, does the `ssr:false` dynamic import).
- **`components/CanvasWorkspace.tsx`** — the tldraw host (`onMount` wires bridge, realtime, mock, outbound sync).
- **`components/Sidebar.tsx`** — app chrome (nav + projects + comms status).
- **`components/Companion.tsx`** — "Rainey" companion placeholder (draggable red reindeer; see `../../docs/COMPANION.md`).
- **`components/shapes/`** — domain `ShapeUtil`s (idea / video / scene / artifact) — _not yet created (TODO)_.
- **`lib/remoteOps.ts`** — ⭐ `applyRemoteOps()` via `store.mergeRemoteChanges` (no echo) + `attachOutboundSync()`.
- **`lib/realtime.ts`** — SSE client (`NEXT_PUBLIC_COMMS_SSE_URL`); no-op until a backend exists.
- **`lib/bridge.ts`** — JS↔Swift bridge (`window.webkit.messageHandlers`, `window.__rainyApplyOps`).
- **`lib/mockComms.ts`** — dev-only demo op source.
- **`lib/store.ts`** — Zustand app/UI state (NOT canvas truth — that lives in the tldraw store).

## Reference (current as of 2026-06-24, not priors)

- `../../knowledge-base/canvas/tldraw-nextjs-integration.md` (tldraw v5 APIs, the no-echo pattern)
- `../../knowledge-base/architecture-patterns/webview-shell-and-data-path.md` (packaging, SSE, data path)
- `../../docs/architecture.md` (canonical) · `../../docs/INTEGRATION_NOTES.md` (divergences) · `../../docs/COMPANION.md`

> ⚠️ **License:** tldraw needs a **Commercial license key** for production (non-localhost HTTPS). Dev is free.
