'use client'

import { useCallback } from 'react'
import {
  Tldraw,
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
import { installBridge } from '@/lib/bridge'
import { attachProjectAutosave, loadProjectIntoEditor } from '@/lib/projectCanvas'
import { connectRealtime } from '@/lib/realtime'
import { attachOutboundSync } from '@/lib/remoteOps'
import { useRainyStore } from '@/lib/store'
import BottomDock from './BottomDock'
import { RainyFrameShapeUtil } from './FrameShape'
import { RainyTextShapeUtil } from './RainyTextShape'
import { VideoBlockShapeUtil } from './VideoBlockShape'

const shapeUtils: TLShapeUtilConstructor<any>[] = [
  RainyFrameShapeUtil,
  RainyTextShapeUtil,
  VideoBlockShapeUtil,
]

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

// Clean canvas: hide all stock tldraw chrome — Rainy provides its own.
const components: TLComponents = {
  Grid: DotGrid,
  // Screen-space overlay on top of the canvas (does NOT replace it, unlike
  // passing children to <Tldraw>). Runs inside the editor context.
  InFrontOfTheCanvas: BottomDock,
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
  const handleMount = useCallback((editor: Editor) => {
    ;(window as any).__rainyEditor = editor

    // Dotted background on; snappy camera (no animation lag on user moves).
    editor.updateInstanceState({ isGridMode: true })
    editor.user.updateUserPreferences({ animationSpeed: 1 })

    // Text cards are created only via the bottom dock (or by the agent). tldraw's
    // built-in double-click-empty gesture would spawn a native 'text' shape, so
    // suppress it: delete any native text shape the instant it's created.
    const suppressNativeText = editor.sideEffects.registerAfterCreateHandler('shape', (created) => {
      if (created.type !== 'text') return
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

    const isBackend = hasBackend() && isBackendId(projectId)

    const disposers: Array<() => void> = [
      suppressNativeText,
      () => editor.off('event', onCanvasEvent),
      installBridge(editor),
      connectRealtime(editor, projectId),
      // Outbound edits: backend projects write user edits through to Postgres
      // (full bidirectional CRUD); local projects forward them to the native shell.
      isBackend ? attachBackendSync(editor, projectId) : attachOutboundSync(editor),
      // Local autosave only for XML/localStorage projects — backend projects are
      // sourced from Postgres and reconciled by realtime, never saved locally.
      ...(isBackend ? [] : [attachProjectAutosave(editor, projectId)]),
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
        { scope: 'session' }
      ),
    ]

    // Render this project's blocks. Backend projects pull from Postgres; if that
    // fails (or it's a local id) fall back to the XML/localStorage project.
    if (isBackend) {
      void loadBackendProject(editor, projectId).then((ok) => {
        if (!ok && !editor.isDisposed) void loadProjectIntoEditor(editor, projectId)
      })
    } else {
      void loadProjectIntoEditor(editor, projectId)
    }

    return () => disposers.forEach((dispose) => dispose())
  }, [projectId])

  return (
    <div className="rainy-canvas">
      <Tldraw
        colorScheme={dark ? 'dark' : 'light'}
        components={components}
        shapeUtils={shapeUtils}
        onMount={handleMount}
      />
    </div>
  )
}
