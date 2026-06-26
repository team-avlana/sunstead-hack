/**
 * Outbound sync: canvas → python-service → Postgres.
 *
 * The read path (Postgres → canvas) lives in `backendCanvas.ts`; this module is
 * the write half that makes the canvas genuinely editable. It listens for genuine
 * USER edits to backend-backed shapes and maps each to an artifact write on the
 * read/write HTTP API:
 *
 *   move / resize        → PUT position  (top-level)  |  element_patch {x,y,w,h}
 *   edit text            → payload_patch {content}    |  element_patch {content}
 *   rename a frame       → payload_patch {label} + title
 *   toggle a video view  → payload_patch {view}       |  element_patch {view}
 *   delete a shape       → DELETE artifact (top-level) |  element_remove (child)
 *   create a block       → POST a new artifact, then "adopt" the shape (id map)
 *
 * Edits are debounced and coalesced per shape. Two guards keep the reconcile loop
 * (`syncBackendProject`, which re-pulls on a websocket signal / poll) from
 * clobbering an edit before it round-trips:
 *   - content-dirty: a freshly edited / actively-edited shape's content is not
 *     overwritten from the DB for a short grace window;
 *   - pending-delete / pending-remove: an artifact the user just deleted is not
 *     re-created from a stale read.
 *
 * Only USER-sourced changes reach here (`source:'user'`); the reconcile loop writes
 * via `mergeRemoteChanges` (`source:'remote'`), so reconciled writes never echo
 * back out as new edits.
 */

import type { Editor, TLShape, TLShapeId } from 'tldraw'
import { IMAGE_BLOCK, RAINY_TEXT, VIDEO_BLOCK, getTextParts, inferFormat } from '@/lib/blockTypes'
import {
  createArtifactResult,
  deleteArtifactResult,
  isTerminalHttp,
  restoreArtifactResult,
  updateArtifact,
  updateArtifactResult,
  type ArtifactPatch,
  type CreateArtifactBody,
  type NewArtifact,
} from './api'
import { frameBox, packColumns, type LayoutBox } from './frameLayout'
import { useRainyStore } from './store'

/** tldraw's built-in frame shape type (used as a flow container). */
const FRAME = 'frame'
/** Backend shapes are id-namespaced `shape:art-<artifactId>[::<elementId>]`. */
const ART_PREFIX = 'shape:art-'

// ── identity: shape id ⇄ artifact ─────────────────────────────────────────────

/**
 * Adoption maps for canvas-authored shapes. A user-created shape keeps its random
 * tldraw id; once we POST an artifact for it we remember the pairing so subsequent
 * edits address the right artifact and reconciliation doesn't spawn a duplicate.
 * Module scope, cleared on dispose (one canvas is mounted at a time).
 */
const tempToArt = new Map<string, string>()
const artToTemp = new Map<string, string>()

export interface ArtRef {
  artifactId: string
  /** Present when the shape is a block inside a frame artifact's payload.elements. */
  elementId?: string
}

/** Resolve a shape id to the artifact (and element) it represents, or null if the
 * shape isn't backend-backed. */
export function resolveArtRef(id: string): ArtRef | null {
  if (id.startsWith(ART_PREFIX)) {
    const rest = id.slice(ART_PREFIX.length)
    const sep = rest.indexOf('::')
    if (sep === -1) return { artifactId: rest }
    return { artifactId: rest.slice(0, sep), elementId: rest.slice(sep + 2) }
  }
  const mapped = tempToArt.get(id)
  return mapped ? { artifactId: mapped } : null
}

const isBackendManaged = (id: string) => id.startsWith(ART_PREFIX) || tempToArt.has(id)

export const isArtifactAdopted = (artifactId: string): boolean => artToTemp.has(artifactId)

// ── reconcile guards (read by backendCanvas.syncBackendProject) ───────────────

/** Artifacts the user just deleted — don't re-create them from a stale read. */
const pendingDelete = new Set<string>()
/** `${artifactId}::${elementId}` for child blocks the user just removed. */
const pendingRemove = new Set<string>()
/** shapeId → epoch-ms until which its content is considered locally owned. */
const dirtyUntil = new Map<string, number>()
/** shapeIds whose content write is in-flight (or retrying). The reconcile loop
 * treats these as dirty so a slow/failed PUT can't be reverted by a re-pull that
 * lands before the write confirms — content-ownership is held until CONFIRMATION,
 * not a fixed wall-clock window. */
const inFlightContent = new Set<string>()

const CONTENT_GRACE_MS = 2500
/** How long a pending delete/remove suppresses re-creation (covers the round-trip). */
const PENDING_TTL_MS = 1500
/** Cap + base for capped-exponential-backoff retries of failed writes. */
const MAX_ATTEMPTS = 5
const backoffMs = (attempt: number) => Math.min(8000, 600 * 2 ** attempt)
/** Defer the actual DELETE so an immediate Cmd+Z cancels it with no HTTP at all. */
const DELETE_DEFER_MS = 550
/** How long after a sent delete an undo can still restore the same artifact. */
const RESTORE_WINDOW_MS = 12000

const markContentDirty = (id: string) => dirtyUntil.set(id, Date.now() + CONTENT_GRACE_MS)

export const isArtifactPendingDelete = (artifactId: string): boolean => pendingDelete.has(artifactId)
export const isElementPendingRemove = (artifactId: string, elementId: string): boolean =>
  pendingRemove.has(`${artifactId}::${elementId}`)

/** True while a shape's content is being actively edited, was just edited, or has
 * a write still in-flight — the reconcile loop skips overwriting its content from
 * the DB during this window. */
export function isContentDirty(editor: Editor, shapeId: TLShapeId): boolean {
  if (editor.getEditingShapeId() === shapeId) return true
  if (inFlightContent.has(shapeId)) return true
  const until = dirtyUntil.get(shapeId)
  return until !== undefined && until > Date.now()
}

/** A stable client-side id used both as the canvas shape's artifact mapping and
 * the server idempotency key, so a retried create never duplicates. */
function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

// ── change → write translation ────────────────────────────────────────────────

const num = (v: unknown, fallback = 0) => (typeof v === 'number' ? Math.round(v) : fallback)

/** The shape's box as a position/geometry record. */
function geomOf(shape: any): { x: number; y: number; w: number; h: number } {
  return { x: num(shape.x), y: num(shape.y), w: num(shape.props?.w), h: num(shape.props?.h) }
}

type Cat = 'geom' | 'content'

/**
 * Decompose a text card's HTML into the self-describing parts a frame's text
 * *element* must carry. The backend (block_normalize) rebuilds the canonical
 * `content` from these parts and lets structured parts win, so a child block must
 * be addressed structurally — sending only `content` would be overwritten by the
 * element's stale title/subtitle/body. `content` is included too so clearing a
 * block (all parts empty) still wipes it. Top-level text blocks are *not*
 * normalized, so those keep raw `content` (see buildPatch). Mirrors blockTypes.ts.
 */
function textElementParts(html: string): Record<string, unknown> {
  const parts = getTextParts(html)
  return {
    format: inferFormat(html),
    title: parts.title,
    subtitle: parts.subtitle,
    body: parts.body,
    content: html,
  }
}

/** Build the PUT body for a backend shape given which categories changed. */
function buildPatch(shape: any, cats: Set<Cat>, ref: ArtRef): ArtifactPatch | null {
  const p = shape.props ?? {}
  // A block inside a frame: address it by element id, coordinates relative to the frame.
  if (ref.elementId) {
    const ep: Record<string, unknown> = {}
    if (cats.has('geom')) {
      ep.x = num(shape.x)
      ep.y = num(shape.y)
      // Persist the box for any block the user can resize. A pinned video keeps
      // its user width on re-pull (height stays content-derived via the auto-fit
      // observer); text + image keep both dimensions.
      if (shape.type === RAINY_TEXT || shape.type === IMAGE_BLOCK || shape.type === VIDEO_BLOCK) {
        ep.w = num(p.w)
        ep.h = num(p.h)
      }
      // Moving/resizing a block pins it out of the frame's auto-layout (persisted
      // so manual placement survives a reload — see frameLayout.relayoutFrame).
      ep.pinned = true
    }
    if (cats.has('content')) {
      if (shape.type === RAINY_TEXT) Object.assign(ep, textElementParts(p.html ?? ''))
      else if (shape.type === VIDEO_BLOCK) ep.view = p.view
    }
    return Object.keys(ep).length ? { element_id: ref.elementId, element_patch: ep } : null
  }

  // A top-level artifact (frame, or a legacy standalone text/video block).
  const body: ArtifactPatch = {}
  if (cats.has('geom')) body.position = geomOf(shape)
  if (cats.has('content')) {
    const pp: Record<string, unknown> = {}
    if (shape.type === RAINY_TEXT) pp.content = p.html ?? ''
    else if (shape.type === VIDEO_BLOCK) pp.view = p.view
    else if (shape.type === FRAME) {
      pp.label = p.name ?? ''
      body.title = p.name ?? '' // keep the artifact title in step with the frame name
    }
    if (Object.keys(pp).length) body.payload_patch = pp
  }
  return body.position || body.payload_patch || body.title !== undefined ? body : null
}

/** Build the create body for a user-authored shape (always top-level). */
function draftArtifact(shape: any): NewArtifact | null {
  const p = shape.props ?? {}
  const position = geomOf(shape)
  if (shape.type === RAINY_TEXT) {
    return { type: 'text', payload: { content: p.html ?? '' }, position }
  }
  if (shape.type === VIDEO_BLOCK) {
    return { type: 'video', payload: { state: 'empty', view: p.view ?? 'expanded' }, position }
  }
  if (shape.type === FRAME) {
    const name = p.name ?? 'Flow'
    return { type: 'frame', title: name, payload: { label: name, elements: [] }, position }
  }
  return null
}

const CREATABLE = new Set<string>([RAINY_TEXT, VIDEO_BLOCK, FRAME])

/** Reconstruct a full element payload from a removed child shape record, so an undo
 * can re-add the element to its frame (the backend element_patch upserts). Returns
 * undefined for shape types that don't map to a frame element. */
function reconstructElementPatch(rec: any): Record<string, unknown> | undefined {
  const p = rec.props ?? {}
  const ep: Record<string, unknown> = {
    x: num(rec.x),
    y: num(rec.y),
    pinned: (rec.meta as { pinned?: unknown })?.pinned === true,
  }
  if (rec.type === RAINY_TEXT) {
    ep.type = 'text'
    ep.w = num(p.w)
    ep.h = num(p.h)
    Object.assign(ep, textElementParts(p.html ?? ''))
  } else if (rec.type === IMAGE_BLOCK) {
    ep.type = 'image'
    ep.w = num(p.w)
    ep.h = num(p.h)
    ep.src = p.src ?? ''
    ep.caption = p.caption ?? ''
    ep.shot_type = p.shotType ?? ''
  } else if (rec.type === VIDEO_BLOCK) {
    ep.type = 'video'
    ep.w = num(p.w)
    ep.h = num(p.h)
    ep.view = p.view ?? 'expanded'
  } else {
    return undefined
  }
  return ep
}

/**
 * Manual "tidy" — re-flow EVERY block in a frame into the clean, non-overlapping
 * column layout (`packColumns`) and persist it, so the arrangement sticks instead
 * of snapping back on the next reload. Unlike the automatic `relayoutFrame` (which
 * leaves pinned, i.e. user-moved, blocks exactly where they are), this treats all
 * blocks as free and clears their pin — the user explicitly asked for everything
 * to be re-arranged.
 *
 * The new positions are applied on-canvas as a remote/history-ignored change — the
 * same channel relayoutFrame writes through — so the move doesn't echo back out as
 * a user edit (which would otherwise re-pin every block, see handleUpdated →
 * pinChild). We then write the new x/y + cleared pin straight to Postgres, one
 * element_patch per block. Because packColumns is idempotent and the pins are now
 * cleared, a reload re-derives the exact same layout. Persistence is a no-op for
 * non-backend (local) frames (their children resolve to no element ref).
 */
export function tidyFrame(editor: Editor, frameId: TLShapeId): void {
  const frame = editor.getShape(frameId)
  if (!frame || frame.type !== FRAME) return
  const kids = editor
    .getSortedChildIdsForParent(frameId)
    .map((id) => editor.getShape(id))
    .filter((sh): sh is TLShape => !!sh)
  const boxes: LayoutBox[] = []
  for (const k of kids) {
    const p = k.props as { w?: unknown; h?: unknown }
    if (typeof p.w === 'number' && typeof p.h === 'number') {
      boxes.push({ id: k.id, x: k.x, y: k.y, w: p.w, h: p.h })
    }
  }
  if (!boxes.length) return

  const pos = packColumns(boxes)
  const enclosing = frameBox(boxes.map((b) => ({ ...b, ...(pos.get(b.id) ?? { x: b.x, y: b.y }) })))

  // 1) Apply on-canvas immediately (derived layout → no outbound echo, no re-pin).
  editor.store.mergeRemoteChanges(() => {
    editor.run(
      () => {
        for (const k of kids) {
          const np = pos.get(k.id)
          if (!np) continue
          editor.updateShape({ id: k.id, type: k.type, x: np.x, y: np.y, meta: { ...k.meta, pinned: false } } as any)
        }
        editor.updateShape({ id: frameId, type: FRAME, props: { w: enclosing.w, h: enclosing.h } } as any)
      },
      { history: 'ignore' },
    )
  })

  // 2) Persist new position + cleared pin per block, so a reload stays tidy.
  for (const k of kids) {
    const np = pos.get(k.id)
    if (!np) continue
    const ref = resolveArtRef(k.id)
    if (!ref?.elementId) continue // top-level / local shape: nothing to persist here
    const ep: Record<string, unknown> = { x: num(np.x), y: num(np.y), pinned: false }
    if (k.type === RAINY_TEXT || k.type === IMAGE_BLOCK) {
      const p = k.props as { w?: unknown; h?: unknown }
      ep.w = num(p.w)
      ep.h = num(p.h)
    }
    void updateArtifact(ref.artifactId, { element_id: ref.elementId, element_patch: ep })
  }
}

// ── attach ────────────────────────────────────────────────────────────────────

/**
 * Wire outbound sync for a backend project. Returns a disposer. No-op for local
 * (XML/localStorage) projects — those use `attachOutboundSync` (remoteOps) instead.
 */
export function attachBackendSync(editor: Editor, projectId: string): () => void {
  const updateTimers = new Map<string, number>()
  const updateCats = new Map<string, Set<Cat>>()
  const updateAttempts = new Map<string, number>()
  const createTimers = new Map<string, number>()
  const createAttempts = new Map<string, number>()
  /** artifactId → timer for a deferred top-level DELETE (cancellable by undo). */
  const deleteTimers = new Map<string, number>()
  /** `${art}::${el}` → timer for a deferred child element_remove. */
  const removeTimers = new Map<string, number>()
  /** artifactIds whose DELETE was sent — an undo within the window restores them. */
  const recentlyDeleted = new Set<string>()
  /** `${art}::${el}` → reconstructed element so an undo can re-add the child. */
  const recentlyRemoved = new Map<string, Record<string, unknown>>()
  /** Keys (shapeId / artifactId / element key) with a write currently failing —
   * drives the "Changes not saved" chip via the store's unsaved counter. */
  const failing = new Set<string>()
  let disposed = false

  const markFailing = (key: string) => {
    if (disposed || failing.has(key)) return
    failing.add(key)
    useRainyStore.getState().bumpUnsaved(1)
  }
  const clearFailing = (key: string) => {
    if (failing.delete(key)) useRainyStore.getState().bumpUnsaved(-1)
  }

  // ── content / geom updates (confirmation-held, retried) ──────────────────────
  const flushUpdate = (shapeId: TLShapeId) => {
    updateTimers.delete(shapeId)
    const cats = updateCats.get(shapeId)
    updateCats.delete(shapeId)
    if (!cats || cats.size === 0) return
    const shape = editor.getShape(shapeId)
    if (!shape) return
    const ref = resolveArtRef(shapeId)
    if (!ref || isArtifactPendingDelete(ref.artifactId)) return
    const body = buildPatch(shape, cats, ref)
    if (!body) return
    const ownsContent = cats.has('content')
    if (ownsContent) inFlightContent.add(shapeId) // hold ownership until confirmed
    void updateArtifactResult(ref.artifactId, body).then((res) => {
      if (disposed) return
      if (res.ok) {
        updateAttempts.delete(shapeId)
        clearFailing(shapeId)
        if (ownsContent) {
          inFlightContent.delete(shapeId)
          markContentDirty(shapeId) // re-arm the grace from CONFIRMATION (covers a stale read already in flight)
        }
        return
      }
      if (isTerminalHttp(res) || editor.isDisposed || !editor.getShape(shapeId)) {
        // Artifact gone / shape gone — drop the write.
        updateAttempts.delete(shapeId)
        if (ownsContent) inFlightContent.delete(shapeId)
        clearFailing(shapeId)
        return
      }
      const n = (updateAttempts.get(shapeId) ?? 0) + 1
      if (n > MAX_ATTEMPTS) {
        updateAttempts.delete(shapeId)
        if (ownsContent) inFlightContent.delete(shapeId)
        markFailing(shapeId)
        return
      }
      // Transient — retry, re-reading the LATEST shape state next flush.
      updateAttempts.set(shapeId, n)
      markFailing(shapeId)
      const set = updateCats.get(shapeId) ?? new Set<Cat>()
      cats.forEach((c) => set.add(c))
      updateCats.set(shapeId, set)
      if (ownsContent) markContentDirty(shapeId)
      window.clearTimeout(updateTimers.get(shapeId))
      updateTimers.set(shapeId, window.setTimeout(() => flushUpdate(shapeId), backoffMs(n)))
    })
  }

  const scheduleUpdate = (shapeId: TLShapeId, cat: Cat) => {
    let set = updateCats.get(shapeId)
    if (!set) {
      set = new Set()
      updateCats.set(shapeId, set)
    }
    set.add(cat)
    if (cat === 'content') markContentDirty(shapeId)
    window.clearTimeout(updateTimers.get(shapeId))
    updateTimers.set(shapeId, window.setTimeout(() => flushUpdate(shapeId), 350))
  }

  // ── creates (idempotent via a client id registered up-front, retried) ────────
  const flushCreate = (shapeId: TLShapeId) => {
    createTimers.delete(shapeId)
    const shape = editor.getShape(shapeId)
    if (!shape) return
    const draft = draftArtifact(shape)
    if (!draft) return
    // Register the mapping BEFORE the POST so (a) the reconcile won't spawn a
    // duplicate while it's in flight (isArtifactAdopted is true), and (b) a retry
    // reuses the same id → the backend upserts instead of inserting twice.
    let artifactId = tempToArt.get(shapeId)
    if (!artifactId) {
      artifactId = uuid()
      tempToArt.set(shapeId, artifactId)
      artToTemp.set(artifactId, shapeId)
    }
    const body: CreateArtifactBody = { ...draft, client_id: artifactId }
    void createArtifactResult(projectId, body).then((res) => {
      if (disposed) return
      if (res.ok) {
        createAttempts.delete(shapeId)
        clearFailing(shapeId)
        return
      }
      if (editor.isDisposed || !editor.getShape(shapeId)) {
        // The user undid the create — drop it (the deferred-delete path, if any,
        // will tidy the server copy).
        createAttempts.delete(shapeId)
        clearFailing(shapeId)
        return
      }
      if (isTerminalHttp(res)) {
        createAttempts.delete(shapeId)
        markFailing(shapeId) // e.g. unknown project — surface, don't silently drop
        return
      }
      const n = (createAttempts.get(shapeId) ?? 0) + 1
      if (n > MAX_ATTEMPTS) {
        createAttempts.delete(shapeId)
        markFailing(shapeId)
        return
      }
      createAttempts.set(shapeId, n)
      markFailing(shapeId)
      window.clearTimeout(createTimers.get(shapeId))
      createTimers.set(shapeId, window.setTimeout(() => flushCreate(shapeId), backoffMs(n)))
    })
  }

  const scheduleCreate = (shapeId: TLShapeId) => {
    window.clearTimeout(createTimers.get(shapeId))
    createTimers.set(shapeId, window.setTimeout(() => flushCreate(shapeId), 500))
  }

  // ── deletes / removes (deferred so undo can cancel; retried; restorable) ─────
  const persistDelete = (artifactId: string, attempt: number) => {
    void deleteArtifactResult(artifactId).then((res) => {
      if (disposed) return
      if (res.ok || isTerminalHttp(res)) {
        clearFailing(artifactId)
        window.setTimeout(() => pendingDelete.delete(artifactId), PENDING_TTL_MS)
        return
      }
      const n = attempt + 1
      if (n > MAX_ATTEMPTS) {
        markFailing(artifactId) // keep pendingDelete set: suppress resurrection
        return
      }
      markFailing(artifactId)
      window.setTimeout(() => persistDelete(artifactId, n), backoffMs(n))
    })
  }
  const commitDelete = (artifactId: string) => {
    deleteTimers.delete(artifactId)
    recentlyDeleted.add(artifactId)
    persistDelete(artifactId, 0)
    window.setTimeout(() => recentlyDeleted.delete(artifactId), RESTORE_WINDOW_MS)
  }

  const persistRemove = (artifactId: string, elementId: string, key: string, attempt: number) => {
    void updateArtifactResult(artifactId, { element_remove: elementId }).then((res) => {
      if (disposed) return
      if (res.ok || isTerminalHttp(res)) {
        clearFailing(key)
        window.setTimeout(() => pendingRemove.delete(key), PENDING_TTL_MS)
        return
      }
      const n = attempt + 1
      if (n > MAX_ATTEMPTS) {
        markFailing(key)
        return
      }
      markFailing(key)
      window.setTimeout(() => persistRemove(artifactId, elementId, key, n), backoffMs(n))
    })
  }
  const commitRemove = (artifactId: string, elementId: string, key: string) => {
    removeTimers.delete(key)
    persistRemove(artifactId, elementId, key, 0)
    window.setTimeout(() => recentlyRemoved.delete(key), RESTORE_WINDOW_MS)
  }

  const cancelPending = (shapeId: TLShapeId) => {
    window.clearTimeout(updateTimers.get(shapeId))
    updateTimers.delete(shapeId)
    updateCats.delete(shapeId)
    updateAttempts.delete(shapeId)
    inFlightContent.delete(shapeId)
    window.clearTimeout(createTimers.get(shapeId))
    createTimers.delete(shapeId)
    createAttempts.delete(shapeId)
  }

  const handleAdded = (rec: any) => {
    const ref = resolveArtRef(rec.id)
    // Undo of a top-level delete: restore the SAME artifact (no new id, no dup).
    if (ref && !ref.elementId && String(rec.id).startsWith(ART_PREFIX)) {
      const aid = ref.artifactId
      const t = deleteTimers.get(aid)
      if (t !== undefined) {
        // DELETE not sent yet — cancelling is free, no HTTP.
        window.clearTimeout(t)
        deleteTimers.delete(aid)
        pendingDelete.delete(aid)
        clearFailing(aid)
        return
      }
      if (recentlyDeleted.has(aid)) {
        recentlyDeleted.delete(aid)
        pendingDelete.add(aid) // suppress resurrection until restore round-trips
        void restoreArtifactResult(aid).then((res) => {
          if (disposed) return
          clearFailing(aid)
          if (!res.ok && !isTerminalHttp(res)) markFailing(aid)
          window.setTimeout(() => pendingDelete.delete(aid), PENDING_TTL_MS)
        })
        return
      }
      return // a backend shape re-added but not from our delete — leave it
    }
    // Undo of a child-block removal.
    if (ref && ref.elementId && String(rec.id).startsWith(ART_PREFIX)) {
      const key = `${ref.artifactId}::${ref.elementId}`
      const t = removeTimers.get(key)
      if (t !== undefined) {
        window.clearTimeout(t)
        removeTimers.delete(key)
        pendingRemove.delete(key)
        clearFailing(key)
        return
      }
      const patch = recentlyRemoved.get(key)
      if (patch) {
        recentlyRemoved.delete(key)
        pendingRemove.add(key)
        // element_patch upserts on the backend, so this re-adds the element.
        void updateArtifactResult(ref.artifactId, { element_id: ref.elementId, element_patch: patch }).then((res) => {
          if (disposed) return
          clearFailing(key)
          if (!res.ok && !isTerminalHttp(res)) markFailing(key)
          window.setTimeout(() => pendingRemove.delete(key), PENDING_TTL_MS)
        })
        return
      }
      return // agent-authored child re-added — backend owns it
    }
    // A brand-new user-authored shape → create it.
    if (isBackendManaged(rec.id) || !CREATABLE.has(rec.type)) return
    // Only adopt top-level shapes — a frame's children are authored by the agent.
    if (typeof rec.parentId === 'string' && rec.parentId.startsWith('shape:')) return
    scheduleCreate(rec.id)
  }

  /** Pin a frame child out of auto-layout the instant it's moved/resized, so the
   * very next `relayoutFrame` (which can fire synchronously on a resize) leaves it
   * put. Written as a remote/history-ignored change → no echo, no re-trigger. */
  const pinChild = (shapeId: TLShapeId) => {
    queueMicrotask(() => {
      if (editor.isDisposed) return
      const sh = editor.getShape(shapeId)
      if (!sh || (sh.meta as any)?.pinned === true) return
      editor.store.mergeRemoteChanges(() => {
        editor.run(
          () => editor.updateShape({ id: shapeId, type: sh.type, meta: { ...sh.meta, pinned: true } } as any),
          { history: 'ignore' },
        )
      })
    })
  }

  const handleUpdated = (from: any, to: any) => {
    if (!isBackendManaged(to.id)) return // an unsaved shape still awaiting its create debounce
    const pf = from.props ?? {}
    const pt = to.props ?? {}
    let geom = false
    let content = false
    if (from.x !== to.x || from.y !== to.y) geom = true
    if (pf.w !== pt.w || pf.h !== pt.h) geom = true
    if (to.type === RAINY_TEXT && pf.html !== pt.html) content = true
    if (to.type === VIDEO_BLOCK && pf.view !== pt.view) content = true
    if (to.type === FRAME && pf.name !== pt.name) content = true
    if (geom) {
      scheduleUpdate(to.id, 'geom')
      if (resolveArtRef(to.id)?.elementId) pinChild(to.id)
    }
    if (content) scheduleUpdate(to.id, 'content')
  }

  const handleRemoved = (records: any[]) => {
    // Top-level deletes first so child removals on a deleted frame can be skipped
    // (deleting a frame cascades to its children in tldraw → a removal per child).
    const deletedArtifacts = new Set<string>()
    for (const rec of records) {
      cancelPending(rec.id)
      const ref = resolveArtRef(rec.id)
      if (!ref || ref.elementId || !isBackendManaged(rec.id)) continue
      const artifactId = ref.artifactId
      deletedArtifacts.add(artifactId)
      pendingDelete.add(artifactId)
      const tempId = artToTemp.get(artifactId)
      if (tempId) {
        artToTemp.delete(artifactId)
        tempToArt.delete(tempId)
      }
      // Defer the actual DELETE so an immediate Cmd+Z cancels it with no HTTP at
      // all; otherwise it's sent (and stays restorable) after the defer window.
      window.clearTimeout(deleteTimers.get(artifactId))
      deleteTimers.set(artifactId, window.setTimeout(() => commitDelete(artifactId), DELETE_DEFER_MS))
    }
    for (const rec of records) {
      const ref = resolveArtRef(rec.id)
      if (!ref || !ref.elementId) continue
      if (deletedArtifacts.has(ref.artifactId)) continue // its frame is going away
      const key = `${ref.artifactId}::${ref.elementId}`
      pendingRemove.add(key)
      const patch = reconstructElementPatch(rec)
      if (patch) recentlyRemoved.set(key, patch) // so an undo can re-add the child
      window.clearTimeout(removeTimers.get(key))
      removeTimers.set(key, window.setTimeout(() => commitRemove(ref.artifactId, ref.elementId as string, key), DELETE_DEFER_MS))
    }
  }

  const unlisten = editor.store.listen(
    (entry) => {
      const removed = Object.values(entry.changes.removed).filter(
        (r: any) => r.typeName === 'shape',
      )
      if (removed.length) handleRemoved(removed)
      for (const pair of Object.values(entry.changes.updated)) {
        const [from, to] = pair as [any, any]
        if (to.typeName === 'shape') handleUpdated(from, to)
      }
      for (const rec of Object.values(entry.changes.added)) {
        if ((rec as any).typeName === 'shape') handleAdded(rec)
      }
    },
    { source: 'user', scope: 'document' },
  )

  return () => {
    disposed = true
    unlisten()
    updateTimers.forEach((t) => window.clearTimeout(t))
    createTimers.forEach((t) => window.clearTimeout(t))
    deleteTimers.forEach((t) => window.clearTimeout(t))
    removeTimers.forEach((t) => window.clearTimeout(t))
    updateTimers.clear()
    updateCats.clear()
    updateAttempts.clear()
    createTimers.clear()
    createAttempts.clear()
    deleteTimers.clear()
    removeTimers.clear()
    recentlyDeleted.clear()
    recentlyRemoved.clear()
    // Release the unsaved counter for anything still failing on this canvas.
    failing.forEach(() => useRainyStore.getState().bumpUnsaved(-1))
    failing.clear()
    tempToArt.clear()
    artToTemp.clear()
    pendingDelete.clear()
    pendingRemove.clear()
    dirtyUntil.clear()
    inFlightContent.clear()
  }
}
