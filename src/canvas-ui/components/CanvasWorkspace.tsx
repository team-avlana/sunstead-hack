'use client'

import { useCallback, useLayoutEffect, useRef } from 'react'
import {
  Tldraw,
  useEditor,
  useValue,
  type Editor,
  type TLComponents,
  type TLEventInfo,
  type TLShapeId,
  type TLShapeUtilConstructor,
} from 'tldraw'
import 'tldraw/tldraw.css'
import { installBridge } from '@/lib/bridge'
import { attachProjectAutosave, loadProjectIntoEditor } from '@/lib/projectCanvas'
import { connectRealtime } from '@/lib/realtime'
import { attachOutboundSync } from '@/lib/remoteOps'
import { useRainyStore } from '@/lib/store'
import BottomDock from './BottomDock'
import { RAINY_TEXT, RainyTextShapeUtil } from './RainyTextShape'
import { VideoBlockShapeUtil } from './VideoBlockShape'

const shapeUtils: TLShapeUtilConstructor<any>[] = [RainyTextShapeUtil, VideoBlockShapeUtil]

/**
 * Dotted background grid that tracks the camera (pan + zoom).
 * Canvas-based so it stays cheap; see knowledge-base/canvas/tldraw-nextjs-integration.md §7.
 */
const DotGrid: NonNullable<TLComponents['Grid']> = ({ size, x, y, z }) => {
  const editor = useEditor()
  const screenBounds = useValue('screenBounds', () => editor.getViewportScreenBounds(), [editor])
  const dpr = useValue('dpr', () => editor.getInstanceState().devicePixelRatio, [editor])
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useLayoutEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const w = Math.ceil(screenBounds.w * dpr)
    const h = Math.ceil(screenBounds.h * dpr)
    cv.width = w
    cv.height = h
    const ctx = cv.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, w, h)

    // Figma-style adaptive spacing: keep dots ~22px+ apart on screen no matter
    // the zoom by drawing only every Nth grid line (N grows as you zoom out).
    const MIN_SCREEN_GAP = 22
    let step = 1
    while (size * step * z < MIN_SCREEN_GAP) step *= 2
    const gap = size * step

    const pb = editor.getViewportPageBounds()
    const startX = Math.ceil(pb.minX / gap) * gap
    const startY = Math.ceil(pb.minY / gap) * gap
    const endX = Math.floor(pb.maxX / gap) * gap
    const endY = Math.floor(pb.maxY / gap) * gap

    const radius = Math.max(0.6, Math.min(1.4, 1.1 * z)) * dpr
    ctx.fillStyle = `rgba(18, 24, 48, ${Math.min(0.16, 0.07 + z * 0.05)})`

    for (let py = startY; py <= endY; py += gap) {
      for (let px = startX; px <= endX; px += gap) {
        const cx = (px + x) * z * dpr
        const cy = (py + y) * z * dpr
        ctx.beginPath()
        ctx.arc(cx, cy, radius, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }, [screenBounds, x, y, z, size, dpr, editor])

  return <canvas className="tl-grid rainy-grid" ref={canvasRef} />
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

    const disposers: Array<() => void> = [
      suppressNativeText,
      () => editor.off('event', onCanvasEvent),
      installBridge(editor),
      connectRealtime(editor),
      attachOutboundSync(editor),
      attachProjectAutosave(editor, projectId),
      editor.store.listen(
        () => useRainyStore.getState().setSelectedIds(editor.getSelectedShapeIds().map(String)),
        { scope: 'session' }
      ),
    ]

    // Render this project's blocks onto the freshly-mounted canvas.
    loadProjectIntoEditor(editor, projectId)

    return () => disposers.forEach((dispose) => dispose())
  }, [projectId])

  return (
    <div className="rainy-canvas">
      <Tldraw colorScheme="light" components={components} shapeUtils={shapeUtils} onMount={handleMount} />
    </div>
  )
}
