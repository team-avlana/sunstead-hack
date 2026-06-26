/**
 * Camera stability + recovery for the infinite canvas.
 *
 * The canvas is intentionally an *infinite, growing* board (the agent creates
 * artifacts; masonry reflows; reconcile re-pulls), so we deliberately do NOT clamp
 * pan with cameraOptions.constraints — a fixed bounds box would make any shape
 * created outside it permanently unreachable (a worse "elements disappear"). The
 * Figma-grade safety net instead is: a sane zoom range, an always-available
 * fit/recenter that recovers from *any* lost camera, fitting into the *visible*
 * region (not under the floating panels), fitting on *settled* sizes, persisting
 * the camera per project, and keeping content from sliding out from under a
 * stationary camera during background reflows.
 *
 * All of this lives here so CanvasWorkspace / backendCanvas / BottomDock share one
 * source of truth for camera math. See docs/INTEGRATION_NOTES.md and the canvas
 * stability audit.
 */

import type { Editor } from 'tldraw'

/** Zoom range for the canvas. First/last define min/max (tldraw convention). We
 * widen the default floor to 5% so a user can always zoom out far enough to find
 * content they've panned away from, and cap at 800%. */
export const ZOOM_STEPS = [0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8]
const ZOOM_MIN = ZOOM_STEPS[0]
const ZOOM_MAX = ZOOM_STEPS[ZOOM_STEPS.length - 1]

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** Apply our camera options once on mount (snappy moves + the widened zoom range,
 * pan left unconstrained for an infinite canvas). */
export function applyCameraOptions(editor: Editor): void {
  try {
    editor.setCameraOptions({ ...editor.getCameraOptions(), zoomSteps: ZOOM_STEPS })
  } catch {
    /* older tldraw / no-op */
  }
}

// ── visible-region insets ────────────────────────────────────────────────────

interface Inset {
  left: number
  right: number
  top: number
  bottom: number
}

/** How much of the canvas rect is obscured by the floating chrome (left sidebar,
 * right Claude panel, top header, bottom dock). Measured live from the DOM so it
 * tracks collapse/open state and can't drift from the CSS; falls back to a small
 * pad when a panel isn't mounted. Coordinates are in screen space (same space as
 * getViewportScreenBounds). */
function chromeInset(editor: Editor): Inset {
  const vsb = editor.getViewportScreenBounds()
  const C = { left: vsb.x, top: vsb.y, right: vsb.x + vsb.w, bottom: vsb.y + vsb.h }
  const PAD = 28
  const inset: Inset = { left: PAD, right: PAD, top: PAD + 64, bottom: PAD + 56 }
  if (typeof document === 'undefined') return inset
  const rect = (sel: string): DOMRect | null => {
    const el = document.querySelector(sel) as HTMLElement | null
    if (!el) return null
    const r = el.getBoundingClientRect()
    return r.width > 1 && r.height > 1 ? r : null
  }
  const sb = rect('.rainy-sidebar')
  if (sb && sb.left <= C.left + 4) inset.left = Math.max(inset.left, sb.right - C.left + 16)
  const cl = rect('.rainy-claude')
  if (cl && cl.right >= C.right - 4) inset.right = Math.max(inset.right, C.right - cl.left + 16)
  const hd = rect('.rainy-project-header')
  if (hd) inset.top = Math.max(PAD, hd.bottom - C.top + 16)
  const dk = rect('.rainy-dock')
  if (dk) inset.bottom = Math.max(PAD, C.bottom - dk.top + 16)
  return inset
}

// ── fit / recenter ───────────────────────────────────────────────────────────

interface FitOpts {
  animation?: { duration: number }
  /** Cap the fit zoom so a tiny single-card project doesn't blow up to 800%. */
  maxZoom?: number
}

/**
 * Fit all content into the *visible* region of the canvas — the rectangle left
 * after subtracting the floating sidebar / Claude panel / header / dock — so
 * content never lands hidden under the chrome. Centers content in that region.
 * No-op when there are no shapes (use fitOrRecenter for a guaranteed recovery).
 */
export function fitContentToVisible(editor: Editor, opts: FitOpts = {}): void {
  const b = editor.getCurrentPageBounds()
  if (!b) return
  const vsb = editor.getViewportScreenBounds()
  const { left, right, top, bottom } = chromeInset(editor)
  const pad = 24
  const visW = Math.max(1, vsb.w - left - right)
  const visH = Math.max(1, vsb.h - top - bottom)
  const bw = Math.max(1, b.w)
  const bh = Math.max(1, b.h)
  const fitZ = Math.min((visW - 2 * pad) / bw, (visH - 2 * pad) / bh)
  const z = clamp(fitZ, ZOOM_MIN, Math.min(ZOOM_MAX, opts.maxZoom ?? 1))
  // Container-relative centre of the visible region.
  const sx = left + visW / 2
  const sy = top + visH / 2
  const midX = b.x + b.w / 2
  const midY = b.y + b.h / 2
  // screen = (page + camera) * z  ⇒  camera = screenTarget/z − pageCentre.
  try {
    editor.setCamera({ x: sx / z - midX, y: sy / z - midY, z }, { animation: opts.animation })
  } catch {
    /* no-op */
  }
}

/**
 * The recovery action behind the dock "Fit" button: frame the content if there is
 * any, otherwise snap the camera back to the origin at 100% — so it ALWAYS gets
 * the user back to a sane view, even on a completely empty/lost canvas (where
 * tldraw's own zoomToFit is a no-op).
 */
export function fitOrRecenter(editor: Editor, animation: { duration: number } = { duration: 220 }): void {
  if (editor.getCurrentPageShapeIds().size > 0) {
    fitContentToVisible(editor, { animation })
  } else {
    try {
      editor.setCamera({ x: 0, y: 0, z: 1 }, { animation })
    } catch {
      /* no-op */
    }
  }
}

export function zoomInStep(editor: Editor): void {
  try {
    editor.zoomIn(editor.getViewportScreenBounds().center, { animation: { duration: 140 } })
  } catch {
    /* no-op */
  }
}

export function zoomOutStep(editor: Editor): void {
  try {
    editor.zoomOut(editor.getViewportScreenBounds().center, { animation: { duration: 140 } })
  } catch {
    /* no-op */
  }
}

export function resetZoom(editor: Editor): void {
  try {
    editor.resetZoom(editor.getViewportScreenBounds().center, { animation: { duration: 160 } })
  } catch {
    /* no-op */
  }
}

// ── settle-then-reveal (fit on the FINAL, settled layout) ─────────────────────

interface SettleOpts {
  reveal: () => void
  /** A saved camera to restore instead of fitting (page-persistence). */
  restore?: { x: number; y: number; z: number } | null
  maxFrames?: number
  stableFrames?: number
}

/**
 * Keep the loading veil up until the page bounds stop changing, fitting on each
 * frame so the camera lands on the *settled* content — not the seed sizes the
 * shapes are created with before tiptap mounts + the ResizeObserver auto-fit +
 * relayoutFrame run. If `restore` is given, don't fit: wait for layout to settle,
 * restore the saved camera, then reveal. Always reveals (via the frame cap) so a
 * never-settling layout can't strand the veil.
 */
export function settleAndReveal(editor: Editor, opts: SettleOpts): void {
  const { reveal, restore = null, maxFrames = 90, stableFrames = 3 } = opts
  if (editor.isDisposed) return reveal()
  if (typeof requestAnimationFrame === 'undefined') return reveal()
  let last = ''
  let stable = 0
  let frames = 0
  const tick = () => {
    if (editor.isDisposed) return reveal()
    frames++
    const b = editor.getCurrentPageBounds()
    if (!b) {
      // No shapes yet (or empty project) — give it a few frames, then reveal.
      if (frames > 12) return reveal()
      return void requestAnimationFrame(tick)
    }
    const key = `${Math.round(b.w)}x${Math.round(b.h)}@${Math.round(b.x)},${Math.round(b.y)}`
    if (key === last) stable++
    else {
      stable = 0
      last = key
    }
    const done = stable >= stableFrames || frames >= maxFrames
    if (restore) {
      if (done) {
        try {
          editor.setCamera({ x: restore.x, y: restore.y, z: restore.z }, { immediate: true })
        } catch {
          /* no-op */
        }
        return reveal()
      }
    } else {
      fitContentToVisible(editor)
      if (done) return reveal()
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

// ── anchored reflow (keep content under the camera during background updates) ──

/**
 * Run `mutate` (a relayout / reconcile that may reposition shapes) while keeping
 * the shape the user is looking at pinned under the same screen pixel, so a
 * background resync never slides content out from under a stationary camera.
 * Skips the camera nudge during an active gesture so it can't fight the user.
 */
export function anchoredReflow(editor: Editor, mutate: () => void): void {
  let dragging = false
  try {
    dragging = editor.inputs.getIsDragging()
  } catch {
    /* older tldraw */
  }
  if (dragging) {
    mutate()
    return
  }
  const anchorId =
    editor.getEditingShapeId() ??
    editor.getSelectedShapeIds()[0] ??
    editor.getShapeAtPoint(editor.getViewportPageBounds().center, { hitInside: true })?.id ??
    null
  const before = anchorId ? editor.getShapePageBounds(anchorId) : null
  mutate()
  if (!anchorId || !before) return
  const after = editor.getShapePageBounds(anchorId)
  if (!after) return
  const dx = after.x - before.x
  const dy = after.y - before.y
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return
  try {
    const cam = editor.getCamera()
    editor.setCamera({ x: cam.x - dx, y: cam.y - dy, z: cam.z })
  } catch {
    /* no-op */
  }
}

// ── per-project camera persistence ────────────────────────────────────────────

const camKey = (projectId: string) => `rainy:cam:${projectId}`

export function readCamera(projectId: string): { x: number; y: number; z: number } | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(camKey(projectId))
    if (!raw) return null
    const o = JSON.parse(raw)
    if (typeof o?.x === 'number' && typeof o?.y === 'number' && typeof o?.z === 'number') return o
  } catch {
    /* ignore */
  }
  return null
}

function writeCamera(projectId: string, cam: { x: number; y: number; z: number }): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(camKey(projectId), JSON.stringify({ x: cam.x, y: cam.y, z: cam.z }))
  } catch {
    /* quota / private mode — non-fatal */
  }
}

/**
 * Persist the camera for a project to localStorage (debounced), restoring the
 * user's exact viewport on the next open/reload (Figma-style). The final position
 * is flushed synchronously on dispose so a fast project switch / reload never
 * drops it.
 */
export function attachCameraPersistence(editor: Editor, projectId: string): () => void {
  let timer: number | undefined
  let lastKey = ''
  const flush = () => {
    if (editor.isDisposed) return
    writeCamera(projectId, editor.getCamera())
  }
  // Session scope fires on every camera frame; dedupe so we only schedule a write
  // when the camera actually moved.
  const unsub = editor.store.listen(
    () => {
      const c = editor.getCamera()
      const key = `${Math.round(c.x)},${Math.round(c.y)},${c.z.toFixed(3)}`
      if (key === lastKey) return
      lastKey = key
      window.clearTimeout(timer)
      timer = window.setTimeout(flush, 300)
    },
    { scope: 'session' },
  )
  return () => {
    unsub()
    window.clearTimeout(timer)
    flush() // flush the pending position so a remount doesn't lose it
  }
}

/** Push the zoom level into the app store on each camera frame (for the dock's
 * zoom readout) without forcing React re-renders elsewhere. Returns a disposer. */
export function subscribeZoom(editor: Editor, onZoom: (z: number) => void): () => void {
  let last = -1
  return editor.store.listen(
    () => {
      const z = editor.getZoomLevel()
      if (Math.abs(z - last) < 0.0005) return
      last = z
      onZoom(z)
    },
    { scope: 'session' },
  )
}

/** Convenience for components that want the live store-less zoom value. */
export const formatZoom = (z: number) => `${Math.round(z * 100)}%`
