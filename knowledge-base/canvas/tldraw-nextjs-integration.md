# tldraw + Next.js (App Router) Integration for the Rainy Canvas

_Last updated: 2026-06-24_

> **Current version:** **tldraw SDK `v5.x`** (latest is **v5.1**, released ~May–June 2026). The major **v5.0** release shipped in **May 2026** and changed several APIs we care about (custom shapes, indicators, dark mode, theming). This doc targets **v5.1** with **Next.js 15.5** and **React 19**, which is what the official `tldraw/nextjs-template` pins.
>
> **Version-sensitivity flags** are called out inline as ⚠️. Anything from v4 or earlier (e.g. `inferDarkMode`, `ShapeUtil.indicator()` returning JSX, props declared only via `static props`) is **out of date** and will not match v5.

---

## 0. Scope & architecture context

Rainy's Canvas UI is a **Next.js (App Router) + tldraw** infinite canvas, rendered inside a SwiftUI `WKWebView`. An external Python **Comms Service** pushes batched ops to the web layer (via WebSocket / `window.webkit.messageHandlers` bridge / postMessage). The web layer applies those ops to tldraw's store **as remote changes** so they do **not** echo back out as "user" edits.

The single most important pattern in this whole document is in **§4**: apply every externally-originated op inside `store.mergeRemoteChanges(...)`, and only forward changes tagged `source: 'user'` back to the Comms Service.

---

## 1. Install + `<Tldraw>` + App Router gotchas

### Install

```bash
npm install tldraw
# peer deps: react@19, react-dom@19 (Next 15.5 ships React 19)
```

Reference `package.json` from the official `tldraw/nextjs-template` (verified 2026-06-24):

```json
{
  "dependencies": {
    "next": "^15.5.16",
    "react": "^19.2.1",
    "react-dom": "^19.2.1",
    "tldraw": "^5.1.1"
  }
}
```

The `tldraw` umbrella package re-exports everything you normally need (`Tldraw`, `Editor`, `ShapeUtil`, `T`, store helpers, etc.). You rarely need to install the lower-level `@tldraw/editor` / `@tldraw/store` packages directly.

### The component + CSS

```tsx
import { Tldraw } from 'tldraw'
import 'tldraw/tldraw.css' // ⚠️ REQUIRED — without this you get an unstyled / broken canvas
```

### App Router gotchas (the important part)

tldraw is a heavy, browser-only component (it touches `window`, `ResizeObserver`, canvas, etc.). It **cannot** be server-rendered.

**Gotcha 1 — `'use client'`.** The file that renders `<Tldraw>` must be a Client Component.

**Gotcha 2 — `ssr: false` cannot live in a Server Component.** In the App Router, `next/dynamic(..., { ssr: false })` is **not allowed inside a Server Component**. You must put the dynamic import inside a file that already has `'use client'`. (This is a real Next 13+/15 App Router restriction.)

**Gotcha 3 — sizing the container.** tldraw fills its parent; the parent needs an explicit, non-zero size. The simplest robust approach is `position: fixed; inset: 0` (what the official template does) or a parent with an explicit height. A zero-height parent = invisible canvas.

#### Pattern A — simplest (official template style)

The official template's `src/app/page.tsx` is literally this — a client component, fixed full-screen, no dynamic import, no manual CSS import (it works because tldraw's CSS is bundled by the example, but **you should still import the CSS** in your own app):

```tsx
// src/app/page.tsx
'use client'

import { Tldraw } from 'tldraw'
import 'tldraw/tldraw.css'

export default function Home() {
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <Tldraw />
    </div>
  )
}
```

This works because a `page.tsx` marked `'use client'` is itself a client boundary, so tldraw never runs on the server. ⚠️ It still gets imported by the server graph; with `'use client'` at the top, Next skips SSR for the component body, but to be bulletproof against hydration mismatches in nested layouts use Pattern B.

#### Pattern B — dynamic import with `ssr: false` (recommended for Rainy)

Use this when `<Tldraw>` is mounted deeper in the tree, or when you want to be 100% certain no SSR/hydration happens (important inside a WKWebView where a flash of unstyled/half-hydrated canvas looks bad).

```tsx
// app/canvas/Canvas.tsx  — the actual tldraw host, browser-only
'use client'

import { Tldraw, type Editor } from 'tldraw'
import 'tldraw/tldraw.css'

export default function Canvas() {
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <Tldraw
        onMount={(editor: Editor) => {
          // wire up the Comms Service bridge here (see §2 / §4)
        }}
      />
    </div>
  )
}
```

```tsx
// app/canvas/CanvasClient.tsx — client wrapper that does the ssr:false dynamic import
'use client'

import dynamic from 'next/dynamic'

// ⚠️ ssr:false is legal HERE because this file is a Client Component
const Canvas = dynamic(() => import('./Canvas'), {
  ssr: false,
  loading: () => <div style={{ position: 'fixed', inset: 0, background: '#101012' }} />,
})

export default function CanvasClient() {
  return <Canvas />
}
```

```tsx
// app/page.tsx — can stay a Server Component
import CanvasClient from './canvas/CanvasClient'

export default function Page() {
  return <CanvasClient />
}
```

> ⚠️ **Why two client files?** `next/dynamic(..., { ssr: false })` throws if used in a Server Component in the App Router. The `CanvasClient` wrapper is the client boundary that legally hosts the `ssr:false` dynamic import; `page.tsx` stays a server component and just renders the wrapper.

---

## 2. The Editor API: getting `editor`, camera/viewport, coordinate spaces

### Getting the editor

The `editor` is the single API entry point. Grab it via `onMount` (fires once the editor is ready):

```tsx
<Tldraw
  onMount={(editor) => {
    // stash it somewhere your Comms bridge can reach it
    window.__rainyEditor = editor // or push into a ref / Zustand store (see §6)
  }}
/>
```

Inside child components you can also use the `useEditor()` hook (must be rendered inside `<Tldraw>`).

### Camera / viewport control (verified v5 signatures)

```ts
editor.setCamera(camera: TLCamera, opts?: TLCameraMoveOptions): this
//   e.g. editor.setCamera({ x: 0, y: 0, z: 1 }, { animation: { duration: 300 } })

editor.zoomToBounds(bounds: Box, opts?: TLCameraMoveOptions): this
//   fit a region into the viewport (great for "focus this node")

editor.getViewportPageBounds(): Box   // viewport rectangle, in PAGE space
editor.getViewportScreenBounds(): Box // viewport rectangle, in SCREEN space

// Convenience camera ops also available: editor.zoomIn(), editor.zoomOut(),
// editor.zoomToFit(), editor.zoomToSelection(), editor.centerOnPoint(point, opts),
// editor.resetZoom().
```

`TLCameraMoveOptions` supports `{ animation: { duration, easing } }` for smooth moves — useful when the Comms Service says "fly to this scene node".

### Coordinate spaces

tldraw has two coordinate spaces you must keep straight:

- **Page space** — the infinite-canvas world coordinates. Shapes' `x`/`y` live here. This is what the Comms Service should speak in.
- **Screen space** — pixels relative to the canvas DOM element (affected by camera pan/zoom).

```ts
editor.screenToPage(point: VecLike): Vec  // pointer/DOM px -> page coords
editor.pageToScreen(point: VecLike): Vec  // page coords -> DOM px
```

Rule of thumb: **all data the Comms Service sends/receives should be in page space**; only convert to screen space for DOM overlays or pointer math.

### Batching / history (used heavily in §4)

```ts
editor.run(fn: (editor) => void, opts?: { history?: 'record' | 'ignore' }): this
editor.markHistoryStoppingPoint(): string  // ⚠️ v5 name; older code used markId()
```

- `editor.run(fn)` runs everything in `fn` as **one transaction** (one re-render, one undo entry).
- `editor.run(fn, { history: 'ignore' })` applies changes **without** creating undo history — ideal for remote/agent-driven edits the user shouldn't be able to "undo into".

---

## 3. Custom shapes via `ShapeUtil` (current v5 signatures)

⚠️ **Big v5 changes vs v2/v3/v4 — read this:**
- Shape props are registered **globally** via TypeScript module augmentation of **`TLGlobalShapePropsMap`** (new in v5). You still also declare `static props` with validators for runtime validation.
- The shape type is now `TLShape<typeof MY_TYPE>` (pulls props from the global map).
- `ShapeUtil.indicator()` (returned JSX) was **removed** → replaced by **`getIndicatorPath()` which returns a `Path2D`** (v5.0 breaking change). Indicators are now drawn on a single HTML canvas for performance.
- Dark mode prop renamed (`inferDarkMode` → `colorScheme`, see §7).

### Minimal v5 custom shape (verified from official example)

```tsx
import {
  Geometry2d,
  HTMLContainer,
  RecordProps,
  Rectangle2d,
  ShapeUtil,
  T,
  TLResizeInfo,
  TLShape,
  Tldraw,
  resizeBox,
} from 'tldraw'
import 'tldraw/tldraw.css'

const VIDEO_CARD = 'video-card'

// 1) Register the shape's props in the global map (v5 module augmentation)
declare module 'tldraw' {
  export interface TLGlobalShapePropsMap {
    [VIDEO_CARD]: { w: number; h: number; title: string; thumbnailUrl: string }
  }
}

// 2) Derive the shape type from the global map
type VideoCardShape = TLShape<typeof VIDEO_CARD>

// 3) The ShapeUtil
export class VideoCardShapeUtil extends ShapeUtil<VideoCardShape> {
  static override type = VIDEO_CARD
  static override props: RecordProps<VideoCardShape> = {
    w: T.number,
    h: T.number,
    title: T.string,
    thumbnailUrl: T.string,
  }

  getDefaultProps(): VideoCardShape['props'] {
    return { w: 280, h: 180, title: 'Untitled', thumbnailUrl: '' }
  }

  override canEdit() { return false }
  override canResize() { return true }
  override isAspectRatioLocked() { return false }

  getGeometry(shape: VideoCardShape): Geometry2d {
    return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true })
  }

  override onResize(shape: VideoCardShape, info: TLResizeInfo<VideoCardShape>) {
    return resizeBox(shape, info)
  }

  // 4) The React body for the shape — full HTML/JSX via HTMLContainer
  component(shape: VideoCardShape) {
    const { title, thumbnailUrl } = shape.props
    return (
      <HTMLContainer
        style={{
          pointerEvents: 'all',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: 12,
          overflow: 'hidden',
          background: '#1b1b1f',
          color: 'white',
        }}
      >
        {thumbnailUrl && (
          <img src={thumbnailUrl} alt="" style={{ width: '100%', height: '60%', objectFit: 'cover' }} />
        )}
        <div style={{ padding: 8, fontSize: 13, fontWeight: 600 }}>{title}</div>
      </HTMLContainer>
    )
  }

  // 5) ⚠️ v5: indicator is now a Path2D, NOT JSX
  getIndicatorPath(shape: VideoCardShape) {
    const path = new Path2D()
    path.rect(0, 0, shape.props.w, shape.props.h)
    return path
  }
}
```

### Register the shape util(s)

```tsx
const shapeUtils = [VideoCardShapeUtil, CreatorCardShapeUtil, SceneNodeShapeUtil, IdeaNoteShapeUtil]

<Tldraw
  shapeUtils={shapeUtils}
  onMount={(editor) => {
    editor.createShape({ type: VIDEO_CARD, x: 100, y: 100 }) // uses getDefaultProps
  }}
/>
```

### Rainy domain nodes

Define one `ShapeUtil` per domain node — **creator card**, **video card**, **scene/analysis node**, **idea/note** — each following the pattern above. Differences are just the `props` map, `getDefaultProps`, and the `component()` body. Put non-validated, app-private data (e.g. backend IDs, analysis status) on the shape's **`meta`** field rather than `props` when you don't want it validated/migrated as part of the shape schema — set it with `editor.updateShape({ id, type, meta: {...} })`.

> ⚠️ **Migrations:** if you change a shape's `props` shape after users have saved documents, add migrations via `createShapePropsMigrationIds` + `createShapePropsMigrationSequence` (v5 API) on the util's `static migrations`. Not needed until your schema is in the wild.

---

## 4. ⭐ Programmatically mutating the canvas from EXTERNAL events (the Comms Service)

This is the heart of the real-time integration. The goal: **apply remote/agent ops without them echoing back out as local edits**, and only ship genuine local user edits back to the Comms Service.

### 4.1 The two halves

| Direction | API | Why |
|---|---|---|
| **Comms Service → Canvas** (apply remote ops) | `editor.store.mergeRemoteChanges(() => { ... })` | Tags changes as `source: 'remote'` so your own outbound listener ignores them → **no feedback loop**. |
| **Canvas → Comms Service** (ship local edits) | `editor.store.listen(cb, { source: 'user', scope: 'document' })` | Only fires for genuine user edits to persistent data. |

### 4.2 Applying remote ops (the no-echo pattern)

`store.mergeRemoteChanges` runs your mutations with the change source marked `'remote'` instead of `'user'`. Your `{ source: 'user' }` listener won't fire for them, so nothing gets shipped back to the server.

```ts
import type { Editor, TLRecord, TLShapeId } from 'tldraw'

// Called by the WKWebView bridge / WebSocket when the Comms Service pings a batch
function applyRemoteOps(
  editor: Editor,
  ops: {
    upsert?: TLRecord[]       // shapes/records to create or update
    remove?: TLShapeId[]      // ids to delete
  }
) {
  editor.store.mergeRemoteChanges(() => {
    if (ops.upsert?.length) {
      editor.store.put(ops.upsert)   // low-level create+update (no history, no echo)
    }
    if (ops.remove?.length) {
      editor.store.remove(ops.remove)
    }
  })
}
```

- `store.put(records)` = create-or-replace at the **store** level (bypasses editor-level history). Use this for raw record diffs coming off the wire.
- `store.remove(ids)` = delete records.
- Everything inside `mergeRemoteChanges` is one atomic batch tagged `remote`.

> ⚠️ **Important nuance:** `mergeRemoteChanges` expects **full records** (validated against the schema), not partials. If the Comms Service sends partial diffs, merge them against the current record before `put`, or use the editor-level API below.

### 4.3 Editor-level API inside a remote batch (when you want semantics, not raw records)

If your Comms ops are semantic ("create a video card at x,y", "update title") rather than raw record diffs, use the editor's typed methods — but still wrap them so they don't pollute undo history and (optionally) tag them remote:

```ts
function applyRemoteSemanticOps(editor: Editor, batch: CommsBatch) {
  editor.store.mergeRemoteChanges(() => {
    editor.run(
      () => {
        for (const op of batch.ops) {
          switch (op.kind) {
            case 'create':
              editor.createShapes(op.shapes)             // TLCreateShapePartial<TShape>[]
              break
            case 'update':
              editor.updateShapes(op.partials)           // TLShapePartial[] (must include id+type)
              break
            case 'delete':
              editor.deleteShapes(op.ids)                // TLShapeId[]
              break
          }
        }
      },
      { history: 'ignore' } // remote/agent edits shouldn't be user-undoable
    )
  })
}
```

Editor-level signatures (verified v5):

```ts
editor.createShape<T extends TLShape>(shape: TLCreateShapePartial<T>): this
editor.createShapes<T extends TLShape>(shapes: TLCreateShapePartial<T>[]): this
editor.updateShapes(partials: TLShapePartial[]): this   // partial must contain id + type
editor.deleteShapes(ids: TLShapeId[]): this
```

> ⚠️ **`mergeRemoteChanges` + `editor.run` nesting:** `mergeRemoteChanges` controls the *source* tag; `editor.run({history:'ignore'})` controls *undo history*. Use both for remote edits: source=remote (no echo) **and** history=ignore (not undoable). There were store-atomicity fixes in this area in 2026 (tldraw PR #5801) — make sure you're on the latest v5.1.x patch.

### 4.4 Shipping LOCAL edits back to the Comms Service

```ts
// Fires ONLY for user-originated changes to persistent (document) data.
// Remote changes applied via mergeRemoteChanges do NOT trigger this. No feedback loop.
const unlisten = editor.store.listen(
  (entry) => {
    // entry.changes is a RecordsDiff:
    //   added:   Record<id, R>
    //   updated: Record<id, [from: R, to: R]>
    //   removed: Record<id, R>
    commsService.send({
      type: 'changes',
      added:   Object.values(entry.changes.added),
      updated: Object.values(entry.changes.updated).map(([, to]) => to),
      removed: Object.keys(entry.changes.removed),
    })
  },
  { source: 'user', scope: 'document' }
)

// later: unlisten()
```

**Listener filters (verified):**

| Filter | Values | Meaning |
|---|---|---|
| `source` | `'user'` \| `'remote'` \| `'all'` | who made the change |
| `scope` | `'document'` \| `'session'` \| `'presence'` \| `'all'` | what kind of data |

For Rainy's outbound sync, **always** use `{ source: 'user', scope: 'document' }` — that's persistent edits the human made, and excludes camera/selection (`session`) and anything you applied via `mergeRemoteChanges`.

### 4.5 End-to-end skeleton (WKWebView bridge flavor)

```tsx
'use client'
import { Tldraw, type Editor } from 'tldraw'
import 'tldraw/tldraw.css'

export default function Canvas() {
  return (
    <Tldraw
      shapeUtils={[/* your domain ShapeUtils */]}
      onMount={(editor) => {
        // INBOUND: Comms Service -> Canvas (via WKWebView message handler / WS)
        const onPing = (batch: any) => applyRemoteOps(editor, batch) // §4.2
        ;(window as any).__rainyApplyOps = onPing // SwiftUI calls window.__rainyApplyOps(...)

        // OUTBOUND: Canvas -> Comms Service (only real user edits)
        const unlisten = editor.store.listen(
          (entry) => {
            window.webkit?.messageHandlers?.comms?.postMessage({
              type: 'changes',
              added: Object.values(entry.changes.added),
              updated: Object.values(entry.changes.updated).map(([, to]: any) => to),
              removed: Object.keys(entry.changes.removed),
            })
          },
          { source: 'user', scope: 'document' }
        )

        return () => unlisten() // onMount cleanup
      }}
    />
  )
}
```

> ⚠️ For full multiplayer (cursors, presence, conflict resolution, reconnection) tldraw ships **`@tldraw/sync`** / `useSync`. For Rainy's "one Python service pings the canvas" model you do **not** need it — the `mergeRemoteChanges` + `store.listen` primitives above are the right, lighter-weight layer. Only reach for `@tldraw/sync` if you add true multi-user editing.

---

## 5. Persistence / snapshots

### Local browser persistence (zero-effort)

```tsx
<Tldraw persistenceKey="rainy-canvas-{projectId}" />
```

`persistenceKey` persists the document to the browser (IndexedDB) and syncs across tabs with the same key. Good for offline resilience inside the WKWebView; **not** a substitute for server state.

### Snapshots (server-backed — what Rainy wants)

```ts
import { getSnapshot, loadSnapshot } from 'tldraw'

// SAVE: serialize current state
const { document, session } = getSnapshot(editor.store)
await fetch('/api/canvas/save', { method: 'POST', body: JSON.stringify({ document }) })
//   document  = persistent shapes/pages (send this to your server)
//   session   = camera/selection/UI (usually keep local per-device)

// RESTORE into a live editor
loadSnapshot(editor.store, savedSnapshot)
```

### Loading initial state from the server at mount

Pass a `snapshot` prop (preferred — initializes before first render, no flash):

```tsx
import { Tldraw, type TLEditorSnapshot } from 'tldraw'
import { useEffect, useState } from 'react'

function ServerCanvas({ documentId }: { documentId: string }) {
  const [snapshot, setSnapshot] = useState<TLEditorSnapshot | null>(null)

  useEffect(() => {
    ;(async () => {
      const document = await fetchDocument(documentId)  // your API
      const session = getLocalSession(documentId)       // optional, per-device camera
      setSnapshot({ document, session })
    })()
  }, [documentId])

  if (!snapshot) return <div style={{ position: 'fixed', inset: 0 }} />
  return <Tldraw snapshot={snapshot} shapeUtils={[/* ... */]} />
}
```

> ⚠️ Snapshots are **schema-versioned**. If you register custom shapes, the same `shapeUtils` must be present when loading a snapshot or migration runs; mismatches throw. Keep custom shape `migrations` updated once documents are persisted server-side.

---

## 6. Reactive state & integrating an external store (Zustand / Jotai)

tldraw has its own reactive system (signals: `atom`, `computed`, `react`, and the `useValue` hook). You generally keep **canvas truth in tldraw's store** and mirror only what your React chrome (side panels, inspector, Comms status) needs into Zustand/Jotai.

### Reading tldraw state reactively in React

```tsx
import { useEditor, useValue } from 'tldraw'

function SelectionCount() {
  const editor = useEditor()
  const count = useValue('selection-count', () => editor.getSelectedShapeIds().length, [editor])
  return <span>{count} selected</span>
}
```

### Bridging tldraw → Zustand (recommended direction)

Mirror selected/derived canvas state into Zustand so non-canvas UI (and the Comms status bar) can subscribe without being inside `<Tldraw>`:

```ts
import { create } from 'zustand'

const useRainyStore = create<{
  selectedIds: string[]
  setSelectedIds: (ids: string[]) => void
}>((set) => ({ selectedIds: [], setSelectedIds: (selectedIds) => set({ selectedIds }) }))

// inside onMount:
editor.store.listen(
  () => useRainyStore.getState().setSelectedIds(editor.getSelectedShapeIds()),
  { scope: 'session' } // selection lives in session scope
)
// or use editor.sideEffects / react() for finer-grained reactions
```

### Bridging Zustand → tldraw

When external (non-canvas) UI needs to change the canvas, call the **editor** from a Zustand action — don't try to make the editor read from Zustand. Treat the editor as the imperative sink. For Comms-driven changes specifically, route them through `applyRemoteOps` (§4) so they stay tagged `remote`.

> Guidance: **don't** try to make tldraw's store and Zustand a single source of truth. Canvas data = tldraw store; app/UI ephemeral state = Zustand/Jotai. Sync one direction per concern.

---

## 7. Customizing UI / theme (toolbar, dark, "liquid glass" chrome, dot grid)

### Dark mode ⚠️ (v5 rename)

```tsx
// ⚠️ v5: `inferDarkMode` is gone. Use `colorScheme` ('light' | 'dark' | 'system').
<Tldraw colorScheme="dark" />
// or follow the OS / WKWebView appearance:
<Tldraw colorScheme="system" />
```

You can also set it at runtime: `editor.user.updateUserPreferences({ colorScheme: 'dark' })`.

### Hiding / replacing UI via the `components` prop

Pass `null` to hide a component, or a React component to replace it. Type is `TLComponents` (a.k.a. `TLUiComponents`).

```tsx
import { Tldraw, type TLComponents } from 'tldraw'

const components: TLComponents = {
  Toolbar: null,        // hide the bottom toolbar
  PageMenu: null,
  StylePanel: null,
  MainMenu: null,
  NavigationPanel: null,
  Minimap: null,
  DebugPanel: null,
  HelpMenu: null,
  ZoomMenu: null,
  // ...or REPLACE one with your own "liquid glass" chrome:
  SharePanel: () => <RainyGlassToolbar />,
}

<Tldraw components={components} />
```

Full set of hideable/replaceable keys (verified): `ContextMenu, ActionsMenu, HelpMenu, ZoomMenu, MainMenu, Minimap, StylePanel, PageMenu, NavigationPanel, Toolbar, KeyboardShortcutsDialog, QuickActions, HelperButtons, DebugPanel, DebugMenu, SharePanel, MenuPanel, TopPanel, CursorChatBubble, RichTextToolbar, ImageToolbar, VideoToolbar, Dialogs, Toasts, A11y, FollowingIndicator, PeopleMenu*` and presence editors.

For a fully custom "liquid glass" look: hide the stock chrome (`Toolbar: null`, `MenuPanel: null`, `PageMenu: null`, etc.) and render your own translucent SwiftUI-matching panels as replacement components or as plain DOM siblings positioned over the canvas. Use `useEditor()` inside them to drive the editor.

### Menu content overrides

To change menu *items* (not whole panels), use the `overrides` prop (`TLUiOverrides`) with methods like `toolbar`, `actions`, `keyboardShortcutsMenu`.

### Theme / custom colors (v5 theme system)

⚠️ v5.0 added a **reactive theme system** (add/remove/change colors & sizes across all default shapes) and a **display-values system** (customize colors/stroke weights/spacing without fragile patches). These let you retheme default shapes to match Rainy's palette without forking. (API surface is newer — verify exact entry points against v5 docs before relying on it; it's the freshest part of the SDK.)

### Dot grid (override the default line grid) ⚠️

Enable grid mode, then replace the `Grid` component. Verified line-grid example below — to make it a **dot grid**, swap the line drawing for `ctx.arc(...)` dots at each `(canvasX, canvasY)` intersection:

```tsx
import { useLayoutEffect, useRef } from 'react'
import { TLComponents, Tldraw, useColorMode, useEditor, useValue } from 'tldraw'
import 'tldraw/tldraw.css'

const components: TLComponents = {
  // Grid receives: size (page-space spacing), and camera x, y, z
  Grid: ({ size, ...camera }) => {
    const editor = useEditor()
    const screenBounds = useValue('screenBounds', () => editor.getViewportScreenBounds(), [])
    const dpr = useValue('dpr', () => editor.getInstanceState().devicePixelRatio, [])
    const isDark = useColorMode() === 'dark'
    const canvas = useRef<HTMLCanvasElement>(null)

    useLayoutEffect(() => {
      const cv = canvas.current
      if (!cv) return
      const w = screenBounds.w * dpr
      const h = screenBounds.h * dpr
      cv.width = w
      cv.height = h
      const ctx = cv.getContext('2d')
      if (!ctx) return
      ctx.clearRect(0, 0, w, h)

      const pb = editor.getViewportPageBounds()
      const startX = Math.ceil(pb.minX / size) * size
      const startY = Math.ceil(pb.minY / size) * size
      const endX = Math.floor(pb.maxX / size) * size
      const endY = Math.floor(pb.maxY / size) * size

      ctx.fillStyle = isDark ? '#555' : '#BBB'
      for (let py = startY; py <= endY; py += size) {
        for (let px = startX; px <= endX; px += size) {
          const cx = (px + camera.x) * camera.z * dpr
          const cy = (py + camera.y) * camera.z * dpr
          ctx.beginPath()
          ctx.arc(cx, cy, 1.5 * dpr, 0, Math.PI * 2) // DOT instead of line
          ctx.fill()
        }
      }
    }, [screenBounds, camera, size, dpr, editor, isDark])

    return <canvas className="tl-grid" ref={canvas} />
  },
}

export default function DotGridCanvas() {
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <Tldraw
        components={components}
        onMount={(e) => e.updateInstanceState({ isGridMode: true })} // turn the grid on
      />
    </div>
  )
}
```

(The original official example draws lines via `drawLine(...)`; the dot version above is the same scaffolding with `ctx.arc` dots. The line/major-line variant is in the Sources link.)

---

## 8. Licensing: watermark vs license key

⚠️ Licensing changed materially in **v4.0** and is current in v5. Summary as of 2026-06-24:

### How the key is applied

```tsx
<Tldraw licenseKey="tldraw-..." />
// also works on the static image renderer:
<TldrawImage snapshot={snapshot} licenseKey="tldraw-..." />
```

- **License keys are public** — safe to ship in frontend code.
- They are **decoded and verified locally**, with **no network request** to any license server (works fully offline / inside WKWebView).

### When is a key required?

Production mode is triggered **only when all three are true simultaneously**:
1. HTTPS (not HTTP), **and**
2. non-`localhost` hostname, **and**
3. `NODE_ENV=production`.

In dev (any of those false) tldraw works **without a key**.

### Tiers & watermark

| Tier | Watermark | Use |
|---|---|---|
| **No key (dev)** | dev watermark / dev-only | local development only |
| **Hobby** | ⚠️ keeps "made with tldraw" watermark | non-commercial / personal |
| **Trial** | no watermark | 100-day evaluation in a live env |
| **Commercial / Business** | **no watermark** | production commercial apps (Rainy) |

Rainy is a commercial product → you need a **Commercial (Business) license key** to run in production **and** to remove the "made with tldraw" watermark. Request via tldraw's plans form; they offered a free 100-day trial license (and, through end of 2025, a discount equal to remaining trial time on a 1-year commercial agreement — verify current promo terms). The full SDK license text lives at tldraw.dev/legal.

> ⚠️ **Action item for Rainy:** obtain a Commercial license key before shipping to the App Store / any non-localhost HTTPS host, or the watermark appears and/or the SDK enters a restricted state.

---

## Sources

- tldraw releases (version verification): https://tldraw.dev/releases
- tldraw SDK 5.0 blog (major release, May 2026): https://tldraw.dev/blog/tldraw-sdk-5-0
- tldraw SDK 4.0 release & licensing model: https://appdevelopermagazine.com/tldraw-sdk-4.0-release-new-starter-kits-and-licensing-model/
- Official Next.js App Router template (versions + integration): https://github.com/tldraw/nextjs-template
- Collaboration / store.listen / mergeRemoteChanges: https://tldraw.dev/sdk-features/collaboration
- Store reference: https://tldraw.dev/reference/store/Store
- Store.atomic + mergeRemoteChanges fixes (PR #5801): https://github.com/tldraw/tldraw/pull/5801
- tldraw sync / useSync: https://tldraw.dev/reference/sync/useSync and https://tldraw.dev/docs/sync
- Shapes guide: https://tldraw.dev/docs/shapes and https://tldraw.dev/sdk-features/shapes
- Custom shape example (v5): https://tldraw.dev/examples/custom-shape
- ShapeUtil reference: https://tldraw.dev/reference/editor/ShapeUtil
- v5.0.0 release notes (breaking changes incl. getIndicatorPath): https://tldraw.dev/releases/v5.0.0
- Editor reference (camera/coords/run signatures): https://tldraw.dev/reference/editor/Editor and https://tldraw.dev/docs/editor
- Persistence (snapshots, persistenceKey): https://tldraw.dev/sdk-features/persistence
- User interface / components: https://tldraw.dev/docs/user-interface
- Hide UI components example: https://tldraw.dev/examples/ui-components-hidden
- Custom grid example: https://tldraw.dev/examples/custom-grid
- Custom canvas components: https://tldraw.dev/examples/custom-components
- License key: https://tldraw.dev/sdk-features/license-key
- License / legal: https://tldraw.dev/community/license and https://tldraw.dev/legal/tldraw-license
- Get a license (hobby / trial): https://tldraw.dev/get-a-license/hobby and https://tldraw.dev/get-a-license/trial
- License updates (Substack): https://tldraw.substack.com/p/license-updates-for-the-tldraw-sdk

> ⚠️ **Uncertain / version-sensitive items to re-verify before building:** (1) exact entry points for the new v5 **theme / display-values** system (freshest API, thinly documented); (2) whether your Comms ops are raw record diffs (use `store.put`) or partials (use editor-level `updateShapes`); (3) current commercial-license pricing/promo terms; (4) store atomicity behavior around nested `mergeRemoteChanges`/`run` — stay on the latest v5.1.x patch (PR #5801 fixes).
