'use client'

import { useState } from 'react'
import { Vec, type Editor, type TLShapeId } from 'tldraw'

/**
 * The circular "delete this block" affordance shared by every canvas block
 * (text / video / frame). White by default, red on hover — see `.shape-trash`
 * in globals.css. It always lives in the same place (straddling the block's
 * top-left corner) so the gesture is identical everywhere.
 *
 * Each block owns its own *visibility* (`show`) since each computes hover a bit
 * differently. The button sits slightly outside the shape's geometry, so once
 * the pointer reaches for it tldraw's own hover signal can drop — `onHoverChange`
 * lets the block keep the button alive while the pointer is on it.
 */
export function DeleteButton({
  editor,
  id,
  show,
  onHoverChange,
  className,
}: {
  editor: Editor
  id: TLShapeId
  show: boolean
  onHoverChange?: (hovering: boolean) => void
  className?: string
}) {
  return (
    <button
      className={`shape-trash${show ? ' show' : ''}${className ? ` ${className}` : ''}`}
      title="Delete"
      aria-label="Delete"
      // Don't let the press start a canvas drag/select on the block underneath.
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
      onMouseEnter={() => onHoverChange?.(true)}
      onMouseLeave={() => onHoverChange?.(false)}
      onClick={(e) => {
        e.stopPropagation()
        editor.deleteShapes([id])
      }}
    >
      <TrashIcon />
    </button>
  )
}

/**
 * The Notion-style "grip" handle shared by every block (text / video / frame):
 * six dots that fade in on hover; press and drag to move the shape — even when
 * the body itself can't be dragged (a text card mid-edit, an expanded video…).
 * Position is tuned per-block via `className` (see `.shape-grip` in globals.css);
 * visibility is driven by the block (`show`).
 *
 * The drag is done by hand (pointer capture + screenToPage → updateShape) rather
 * than handing the gesture to tldraw's translate tool, so it works from an HTML
 * overlay and routes through the same move pipeline as any other move — the
 * outbound sync persists the new position and a moved frame-child gets pinned out
 * of auto-layout. A single history mark makes the whole drag one undo step.
 *
 * Magnetic snapping matches dragging by the body: each move asks tldraw's snap
 * manager for the alignment nudge and lets it paint the same guide lines, gated on
 * the exact same snap-mode/accel-key rule the native translate tool uses (see
 * tldraw's Translating.moveShapesToPoint) — so the grip and the body feel identical.
 */
export function DragHandle({
  editor,
  id,
  show,
  onHoverChange,
  className,
}: {
  editor: Editor
  id: TLShapeId
  show: boolean
  onHoverChange?: (hovering: boolean) => void
  className?: string
}) {
  const [dragging, setDragging] = useState(false)

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return // left button only
    e.preventDefault()
    e.stopPropagation() // don't let tldraw also start a select/drag underneath
    const shape = editor.getShape(id)
    if (!shape) return
    editor.setSelectedShapes([id])
    editor.markHistoryStoppingPoint('drag-handle')
    // Page-space anchor + the shape's start origin. screenToPage folds in pan/zoom,
    // and frames are translation-only, so a page-space delta is also the right
    // delta for a frame-local child's x/y.
    const start = editor.screenToPage({ x: e.clientX, y: e.clientY })
    const ox = shape.x
    const oy = shape.y
    // Snap inputs captured once at drag start (page space), mirroring tldraw's own
    // translate snapshot: the shape's starting page bounds and its snap points.
    // Frames are translation-only, so a page-space nudge maps straight onto the
    // shape's (possibly frame-local) x/y — same reasoning as the raw delta above.
    const initialPageBounds = editor.getShapePageBounds(id)
    const initialSnapPoints = editor.snaps.shapeBounds.getSnapPoints(id)
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    setDragging(true)
    const move = (ev: PointerEvent) => {
      const p = editor.screenToPage({ x: ev.clientX, y: ev.clientY })
      const delta = new Vec(p.x - start.x, p.y - start.y)
      // Recomputed each move: clear last frame's guides, then (when snapping is
      // active) ask the snap manager for the nudge that aligns this shape with its
      // neighbours. snapTranslateShapes paints the guide lines as a side effect.
      editor.snaps.clearIndicators()
      const accel = editor.inputs.getAccelKey()
      const isSnapping = editor.user.getIsSnapMode() ? !accel : accel
      if (isSnapping && initialPageBounds) {
        const { nudge } = editor.snaps.shapeBounds.snapTranslateShapes({
          dragDelta: delta,
          initialSelectionPageBounds: initialPageBounds,
          lockedAxis: null,
          initialSelectionSnapPoints: initialSnapPoints,
        })
        delta.add(nudge)
      }
      editor.updateShape({ id, type: shape.type, x: ox + delta.x, y: oy + delta.y })
    }
    const end = () => {
      try {
        el.releasePointerCapture(e.pointerId)
      } catch {
        /* pointer already released */
      }
      editor.snaps.clearIndicators() // drop any guide lines still showing
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', end)
      el.removeEventListener('pointercancel', end)
      setDragging(false)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', end)
    el.addEventListener('pointercancel', end)
  }

  return (
    <div
      className={`shape-grip${show ? ' show' : ''}${dragging ? ' dragging' : ''}${className ? ` ${className}` : ''}`}
      title="Drag to move"
      aria-label="Drag to move"
      role="button"
      onPointerDown={onPointerDown}
      onMouseEnter={() => onHoverChange?.(true)}
      onMouseLeave={() => onHoverChange?.(false)}
    >
      <GripIcon />
    </div>
  )
}

function GripIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="9" cy="5" r="1.6" />
      <circle cx="15" cy="5" r="1.6" />
      <circle cx="9" cy="12" r="1.6" />
      <circle cx="15" cy="12" r="1.6" />
      <circle cx="9" cy="19" r="1.6" />
      <circle cx="15" cy="19" r="1.6" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  )
}
