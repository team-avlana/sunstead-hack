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

import type { Editor, TLShapeId } from 'tldraw'
import { RAINY_TEXT, VIDEO_BLOCK, getTextParts, inferFormat } from '@/lib/blockTypes'
import {
  createArtifact,
  deleteArtifact,
  updateArtifact,
  type ArtifactPatch,
  type NewArtifact,
} from './api'

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

const CONTENT_GRACE_MS = 2000
/** How long a pending delete/remove suppresses re-creation (covers the round-trip). */
const PENDING_TTL_MS = 1500

const markContentDirty = (id: string) => dirtyUntil.set(id, Date.now() + CONTENT_GRACE_MS)

export const isArtifactPendingDelete = (artifactId: string): boolean => pendingDelete.has(artifactId)
export const isElementPendingRemove = (artifactId: string, elementId: string): boolean =>
  pendingRemove.has(`${artifactId}::${elementId}`)

/** True while a shape's content is being actively edited or was just edited — the
 * reconcile loop skips overwriting its content from the DB during this window. */
export function isContentDirty(editor: Editor, shapeId: TLShapeId): boolean {
  if (editor.getEditingShapeId() === shapeId) return true
  const until = dirtyUntil.get(shapeId)
  return until !== undefined && until > Date.now()
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
      if (shape.type === RAINY_TEXT) {
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

// ── attach ────────────────────────────────────────────────────────────────────

/**
 * Wire outbound sync for a backend project. Returns a disposer. No-op for local
 * (XML/localStorage) projects — those use `attachOutboundSync` (remoteOps) instead.
 */
export function attachBackendSync(editor: Editor, projectId: string): () => void {
  const updateTimers = new Map<string, number>()
  const updateCats = new Map<string, Set<Cat>>()
  const createTimers = new Map<string, number>()

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
    if (body) void updateArtifact(ref.artifactId, body)
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

  const flushCreate = (shapeId: TLShapeId) => {
    createTimers.delete(shapeId)
    const shape = editor.getShape(shapeId)
    if (!shape || isBackendManaged(shapeId)) return
    const draft = draftArtifact(shape)
    if (!draft) return
    void createArtifact(projectId, draft).then((res) => {
      // Adopt only if the shape still exists (user may have undone the create).
      if (!res || editor.isDisposed || !editor.getShape(shapeId)) return
      tempToArt.set(shapeId, res.artifact_id)
      artToTemp.set(res.artifact_id, shapeId)
    })
  }

  const scheduleCreate = (shapeId: TLShapeId) => {
    window.clearTimeout(createTimers.get(shapeId))
    createTimers.set(shapeId, window.setTimeout(() => flushCreate(shapeId), 500))
  }

  const cancelPending = (shapeId: TLShapeId) => {
    window.clearTimeout(updateTimers.get(shapeId))
    updateTimers.delete(shapeId)
    updateCats.delete(shapeId)
    window.clearTimeout(createTimers.get(shapeId))
    createTimers.delete(shapeId)
  }

  const handleAdded = (rec: any) => {
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
      void deleteArtifact(artifactId).finally(() => {
        window.setTimeout(() => pendingDelete.delete(artifactId), PENDING_TTL_MS)
      })
    }
    for (const rec of records) {
      const ref = resolveArtRef(rec.id)
      if (!ref || !ref.elementId) continue
      if (deletedArtifacts.has(ref.artifactId)) continue // its frame is going away
      const key = `${ref.artifactId}::${ref.elementId}`
      pendingRemove.add(key)
      void updateArtifact(ref.artifactId, { element_remove: ref.elementId }).finally(() => {
        window.setTimeout(() => pendingRemove.delete(key), PENDING_TTL_MS)
      })
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
    unlisten()
    updateTimers.forEach((t) => window.clearTimeout(t))
    createTimers.forEach((t) => window.clearTimeout(t))
    updateTimers.clear()
    updateCats.clear()
    createTimers.clear()
    tempToArt.clear()
    artToTemp.clear()
    pendingDelete.clear()
    pendingRemove.clear()
    dirtyUntil.clear()
  }
}
