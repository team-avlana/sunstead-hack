'use client'

import type { Editor, TLShapeId } from 'tldraw'

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
