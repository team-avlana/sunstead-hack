'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Tldraw,
  renderPlaintextFromRichText,
  type Editor,
  type TLComponents,
  type TLEventInfo,
  type TLShapeId,
  type TLShapeUtilConstructor,
} from 'tldraw'
import 'tldraw/tldraw.css'
import { hasBackend, isBackendId } from '@/lib/api'
import { RAINY_TEXT } from '@/lib/blockTypes'
import { loadBackendProject } from '@/lib/backendCanvas'
import { attachBackendSync } from '@/lib/backendSync'
import {
  applyCameraOptions,
  attachCameraPersistence,
  fitContentToVisible,
  readCamera,
  settleAndReveal,
} from '@/lib/camera'
import { installBridge } from '@/lib/bridge'
import { attachProjectAutosave, loadProjectIntoEditor } from '@/lib/projectCanvas'
import { connectRealtime } from '@/lib/realtime'
import { attachOutboundSync } from '@/lib/remoteOps'
import { useRainyStore } from '@/lib/store'
import BottomDock from './BottomDock'
import { RainyFrameShapeUtil } from './FrameShape'
import { RainyTextShapeUtil } from './RainyTextShape'
import { VideoBlockShapeUtil } from './VideoBlockShape'
import { ImageBlockShapeUtil } from './ImageBlockShape'
import { KeyframeTrackShapeUtil } from './KeyframeTrackShape'

const shapeUtils: TLShapeUtilConstructor<any>[] = [
  RainyFrameShapeUtil,
  RainyTextShapeUtil,
  VideoBlockShapeUtil,
  ImageBlockShapeUtil,
  KeyframeTrackShapeUtil,
]

const isBackendShapeId = (id: string) => id.startsWith('shape:art-')
/** Deleting more than this many backend blocks at once asks for confirmation. */
const BULK_DELETE_CONFIRM_AT = 3

/**
 * Dotted background grid that tracks the camera (pan + zoom).
 *
 * Rendered as a single CSS radial-gradient tile rather than thousands of
 * per-frame canvas `arc()` fills: panning only updates `background-position`
 * (a GPU compositor transform — no repaint, no main-thread work), and zoom
 * only updates `background-size`. tldraw re-invokes this on each camera frame,
 * but all it does now is write a couple of style strings. See knowledge-base/
 * canvas/tldraw-nextjs-integration.md §7.
 */
const DotGrid: NonNullable<TLComponents['Grid']> = ({ size, x, y, z }) => {
  const dark = useRainyStore((s) => s.dark)

  // Figma-style adaptive spacing: keep dots ~22px+ apart on screen no matter
  // the zoom by drawing only every Nth grid line (N grows as you zoom out).
  const MIN_SCREEN_GAP = 22
  let step = 1
  while (size * step * z < MIN_SCREEN_GAP) step *= 2
  const screenGap = size * step * z

  const radius = Math.max(0.6, Math.min(1.4, 1.1 * z))
  // Light mode: dark ink dots on a light canvas. Dark mode: light dots on a
  // dark canvas (slightly brighter so they stay legible against the deep bg).
  const alpha = Math.min(0.16, 0.07 + z * 0.05)
  const dot = dark
    ? `rgba(150, 165, 210, ${Math.min(0.22, alpha + 0.05)})`
    : `rgba(18, 24, 48, ${alpha})`

  return (
    <div
      className="rainy-grid"
      style={{
        position: 'absolute',
        inset: 0,
        // One dot per tile; `+0.6` gives a soft 0.6px antialiased edge.
        backgroundImage: `radial-gradient(circle at center, ${dot} ${radius}px, transparent ${radius + 0.6}px)`,
        backgroundSize: `${screenGap}px ${screenGap}px`,
        // Anchor the tiling to the page origin so dots track content while panning.
        backgroundPosition: `${x * z}px ${y * z}px`,
      }}
    />
  )
}

/** Non-blocking connection / save-health chip (bottom-left, clear of the dock).
 * Surfaces the otherwise-invisible offline + unsaved-write states so the canvas
 * is never silently stale. Debounced so a 1.8s reconnect blip doesn't flicker. */
function CommsChip() {
  const comms = useRainyStore((s) => s.commsStatus)
  const unsaved = useRainyStore((s) => s.unsavedCount)
  const [showReconnect, setShowReconnect] = useState(false)

  // Only surface "Reconnecting…" once it has persisted >2.5s — the WS retries on a
  // backoff and flips to 'reconnecting' on every blip, so binding it raw would
  // flicker the chip on a flaky network.
  useEffect(() => {
    if (comms !== 'reconnecting') {
      setShowReconnect(false)
      return
    }
    const t = window.setTimeout(() => setShowReconnect(true), 2500)
    return () => window.clearTimeout(t)
  }, [comms])

  if (unsaved > 0) {
    return (
      <div className="rainy-comms warn" role="status">
        <span className="rainy-comms-dot" />
        {`Changes not saved — retrying${unsaved > 1 ? ` (${unsaved})` : ''}`}
      </div>
    )
  }
  if (showReconnect) {
    return (
      <div className="rainy-comms" role="status">
        <span className="rainy-comms-dot" />
        Reconnecting…
      </div>
    )
  }
  return null
}

/** Screen-space overlays rendered inside the editor context: the dock + the
 * connection chip. (One wrapper because InFrontOfTheCanvas is a single slot.) */
const Overlays = () => (
  <>
    <BottomDock />
    <CommsChip />
  </>
)

// Clean canvas: hide all stock tldraw chrome — Rainy provides its own.
const components: TLComponents = {
  Grid: DotGrid,
  // Screen-space overlay on top of the canvas (does NOT replace it, unlike
  // passing children to <Tldraw>). Runs inside the editor context.
  InFrontOfTheCanvas: Overlays,
  Toolbar: null,
  MainMenu: null,
  PageMenu: null,
  StylePanel: null,
  NavigationPanel: null,
  ZoomMenu: null,
  QuickActions: null,
  ActionsMenu: null,
  HelpMenu: null,
  HelperButtons: null,
  DebugPanel: null,
  DebugMenu: null,
  Minimap: null,
  MenuPanel: null,
  TopPanel: null,
  KeyboardShortcutsDialog: null,
}

export default function CanvasWorkspace({ projectId }: { projectId: string }) {
  const dark = useRainyStore((s) => s.dark)
  const loadState = useRainyStore((s) => s.loadState)
  const editorRef = useRef<Editor | null>(null)
  // Gentle loading veil: shown over the canvas while this project's artifacts are
  // fetched from Postgres (or local storage) and laid out, then faded out once the
  // final arrangement has settled. Resets per project (the canvas remounts by key).
  const [ready, setReady] = useState(false)

  const isBackend = hasBackend() && isBackendId(projectId)

  // Retry a failed backend load (driven by the error overlay's button).
  const retryLoad = useCallback(() => {
    const editor = editorRef.current
    if (!editor || editor.isDisposed) return
    useRainyStore.getState().setLoadState('loading')
    void loadBackendProject(editor, projectId).then((kind) => {
      if (kind === 'ok' && !editor.isDisposed) fitContentToVisible(editor, { animation: { duration: 220 } })
    })
  }, [projectId])

  const handleMount = useCallback(
    (editor: Editor) => {
      editorRef.current = editor
      ;(window as any).__rainyEditor = editor

      // Dotted background on; snappy camera; widened zoom range with a 5% floor so
      // you can always zoom out far enough to find content you've panned away from.
      editor.updateInstanceState({ isGridMode: true })
      editor.user.updateUserPreferences({ animationSpeed: 1 })
      applyCameraOptions(editor)

      // Text cards are created only via the bottom dock (or by the agent). tldraw's
      // built-in double-click-empty gesture spawns an EMPTY native 'text' shape — we
      // suppress those — but a paste of text also creates a native 'text' shape that
      // already carries content, and we must NOT nuke that (it would make pasted text
      // flash and vanish). So only delete native text that is empty.
      const suppressNativeText = editor.sideEffects.registerAfterCreateHandler('shape', (created) => {
        if (created.type !== 'text') return
        const rt = (created.props as any).richText
        if (rt && renderPlaintextFromRichText(editor, rt).trim()) return // pasted content — keep it
        queueMicrotask(() => {
          if (editor.getShape(created.id)) editor.deleteShapes([created.id])
        })
      })

      // Tap-to-edit: a quick press (≤140ms) without a drag on a Rainy text card
      // drops you straight into editing with the caret showing — no double-click
      // needed. A real slide (tldraw starts dragging once the pointer moves past
      // its threshold) is left alone, so press-and-drag still moves the card.
      const TAP_MS = 140
      let tapDownAt = 0
      let tapDownId: TLShapeId | null = null
      const rainyAt = (): TLShapeId | null => {
        const hit = editor.getShapeAtPoint(editor.inputs.getCurrentPagePoint(), { hitInside: true, margin: 0 })
        return hit && editor.getShape(hit.id)?.type === RAINY_TEXT ? hit.id : null
      }
      const onCanvasEvent = (info: TLEventInfo) => {
        if (info.type !== 'pointer') return
        if (info.name === 'pointer_down') {
          tapDownAt = performance.now()
          tapDownId = rainyAt()
        } else if (info.name === 'pointer_up') {
          const id = tapDownId
          tapDownId = null
          if (!id) return
          // A modifier press is a selection gesture (shift/cmd/ctrl-click to
          // extend/toggle) — leave it to tldraw, don't hijack it into edit mode.
          if (info.shiftKey || info.ctrlKey || info.metaKey || info.accelKey) return
          if (editor.getEditingShapeId() === id) return // already editing — let the text place its own caret
          if (editor.inputs.getIsDragging()) return // it was a drag → tldraw moved it
          if (performance.now() - tapDownAt > TAP_MS) return // too slow to count as a tap
          if (rainyAt() !== id) return // released off the card
          editor.run(() => {
            editor.select(id)
            editor.setEditingShape(id)
            editor.setCurrentTool('select.editing_shape')
          })
        }
      }
      editor.on('event', onCanvasEvent)

      // Guard a bulk delete: select-all + Delete would wipe every artifact in
      // Postgres at once. Confirm before letting it through (capture phase, so we
      // can cancel tldraw's own delete). Never intercept while editing text.
      const onKeyCapture = (e: KeyboardEvent) => {
        if (e.key !== 'Delete' && e.key !== 'Backspace') return
        if (editor.getEditingShapeId()) return
        const ids = editor.getSelectedShapeIds()
        const backendCount = ids.filter((id) => isBackendShapeId(String(id))).length
        if (backendCount > BULK_DELETE_CONFIRM_AT) {
          const ok = window.confirm(
            `Delete ${ids.length} block${ids.length === 1 ? '' : 's'}? This removes them everywhere — you can undo right after.`,
          )
          if (!ok) {
            e.preventDefault()
            e.stopPropagation()
          }
        }
      }
      window.addEventListener('keydown', onKeyCapture, { capture: true })

      const disposers: Array<() => void> = [
        suppressNativeText,
        () => editor.off('event', onCanvasEvent),
        () => window.removeEventListener('keydown', onKeyCapture, { capture: true }),
        installBridge(editor),
        connectRealtime(editor, projectId),
        // Outbound edits: backend projects write user edits through to Postgres
        // (full bidirectional CRUD); local projects forward them to the native shell.
        isBackend ? attachBackendSync(editor, projectId) : attachOutboundSync(editor),
        // Local autosave only for XML/localStorage projects — backend projects are
        // sourced from Postgres and reconciled by realtime, never saved locally.
        ...(isBackend ? [] : [attachProjectAutosave(editor, projectId)]),
        // Persist + restore the camera per project (Figma-style viewport memory).
        attachCameraPersistence(editor, projectId),
        // Mirror selection into the app store for the adaptive sidebar. Session
        // scope also fires on every camera frame, so bail unless the ids actually
        // changed — otherwise the sidebar re-derives on each pan/zoom.
        editor.store.listen(
          () => {
            const ids = editor.getSelectedShapeIds().map(String)
            const prev = useRainyStore.getState().selectedIds
            if (ids.length === prev.length && ids.every((id, i) => id === prev[i])) return
            useRainyStore.getState().setSelectedIds(ids)
          },
          { scope: 'session' },
        ),
      ]

      // Reveal the canvas once shapes are created AND their async auto-fit/relayout
      // have settled — fitting on each frame so the camera lands on the FINAL
      // arrangement (not the seed sizes), or restoring the user's saved viewport.
      // A timeout backstop lifts it regardless if a fetch hangs.
      let revealed = false
      const reveal = () => {
        if (revealed) return
        revealed = true
        if (!editor.isDisposed) setReady(true)
      }
      const backstop = window.setTimeout(reveal, 8000)
      const savedCamera = readCamera(projectId)
      const finishLoading = () => settleAndReveal(editor, { reveal, restore: savedCamera })

      // Render this project's blocks. Backend projects pull from Postgres; on
      // failure we surface an error/retry overlay (driven by loadState) rather than
      // a silently-blank canvas — never the empty local fallback (it always 404s
      // for a backend UUID).
      if (isBackend) {
        void loadBackendProject(editor, projectId).finally(finishLoading)
      } else {
        void loadProjectIntoEditor(editor, projectId)
          .finally(() => {
            useRainyStore.getState().setLoadState('ok')
            finishLoading()
          })
      }

      disposers.push(() => window.clearTimeout(backstop))
      return () => disposers.forEach((dispose) => dispose())
    },
    [projectId, isBackend],
  )

  const showError = loadState === 'unreachable' || loadState === 'notfound'

  return (
    <div className="rainy-canvas">
      <Tldraw
        colorScheme={dark ? 'dark' : 'light'}
        components={components}
        shapeUtils={shapeUtils}
        onMount={handleMount}
      />
      {/* Gentle on-brand loading veil; `is-ready` fades it out once laid out. */}
      <div className={`rainy-loading${ready ? ' is-ready' : ''}`} aria-hidden={ready}>
        <div className="rainy-loading-orb" />
        <div className="rainy-loading-label">Setting up your canvas…</div>
      </div>

      {/* Failure fallback: a clear error card instead of a blank canvas. Auto-
          dismisses when a background re-pull succeeds (loadState → 'ok'). */}
      {showError && (
        <div className="rainy-error" role="alert">
          <div className="rainy-error-card">
            <div className="rainy-error-glyph">
              {loadState === 'notfound' ? <NotFoundGlyph /> : <OfflineGlyph />}
            </div>
            <div className="rainy-error-title">
              {loadState === 'notfound' ? 'This project no longer exists' : "Can't reach the canvas service"}
            </div>
            <div className="rainy-error-sub">
              {loadState === 'notfound'
                ? 'It may have been deleted. Head back to your projects.'
                : 'Your work is safe. We’ll keep trying to reconnect.'}
            </div>
            <div className="rainy-error-actions">
              {loadState === 'notfound' ? (
                <button className="rainy-error-btn primary" onClick={() => useRainyStore.getState().goHome()}>
                  Go to projects
                </button>
              ) : (
                <>
                  <button className="rainy-error-btn primary" onClick={retryLoad}>
                    Retry
                  </button>
                  <button className="rainy-error-btn" onClick={() => useRainyStore.getState().goHome()}>
                    Go home
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function OfflineGlyph() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12.55a11 11 0 0 1 14 0" />
      <path d="M8.5 16.1a6 6 0 0 1 7 0" />
      <line x1="12" y1="20" x2="12.01" y2="20" />
      <line x1="2" y1="2" x2="22" y2="22" />
    </svg>
  )
}

function NotFoundGlyph() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.5l5 5M14.5 9.5l-5 5" />
    </svg>
  )
}
