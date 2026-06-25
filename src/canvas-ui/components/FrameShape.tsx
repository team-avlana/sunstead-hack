'use client'

import { useState } from 'react'
import {
  FrameShapeUtil,
  HTMLContainer,
  SVGContainer,
  useEditor,
  useValue,
  type Editor,
  type TLFrameShape,
  type TLShape,
  type TLShapeId,
} from 'tldraw'
import { tidyFrame } from '@/lib/backendSync'
import { getSquirclePath } from '@/lib/squircle'
import { DeleteButton, DragHandle } from './ShapeChrome'

/** iOS-style corner radius (page units) for canvas frames. */
const FRAME_RADIUS = 24
const FRAME_SMOOTHING = 0.6

/**
 * Rainy's frame: tldraw's built-in flow container, reskinned to match the app —
 * an iOS squircle body (continuous corners) with a soft tinted drop shadow and a
 * clean hairline, instead of the stock white box + hard border.
 *
 * We extend the built-in util so all of its behaviour (geometry, child clipping,
 * the editable heading) is inherited untouched; we only swap the painted body and
 * add the shared hover delete button.
 */
export class RainyFrameShapeUtil extends FrameShapeUtil {
  // Each child block's chrome — the delete button and the drag grip — deliberately
  // straddles the card's top-left corner, sitting a few px *outside* the card's box
  // (see `.shape-trash` / `.shape-grip` in globals.css). A frame normally clips its
  // children to its own bounds, which sliced that chrome off whenever a card sat
  // near a frame edge (the cropped trash/grip in the canvas). Our frames auto-grow
  // to enclose their children (`relayoutFrame`), so this clip never trimmed real
  // content — only the chrome — so we opt children out of clipping entirely and let
  // the chrome (and the text block's hover toolbar) render in full above the frame.
  override shouldClipChild(_child: TLShape) {
    return false
  }

  override component(shape: TLFrameShape) {
    const { w, h } = shape.props
    const d = getSquirclePath(w, h, FRAME_RADIUS, FRAME_SMOOTHING)
    return (
      <>
        <SVGContainer className="rainy-frame-svg">
          <path className="rainy-frame-body" d={d} />
        </SVGContainer>
        {/* Inherited body rect (hidden) + the editable frame heading. */}
        {super.component(shape)}
        <FrameChrome shape={shape} />
      </>
    )
  }

  override indicator(shape: TLFrameShape) {
    const { w, h } = shape.props
    return <path d={getSquirclePath(w, h, FRAME_RADIUS, FRAME_SMOOTHING)} />
  }
}

/**
 * The frame's hover chrome: the delete button + drag grip on the left, and a
 * "tidy" button on the right that re-arranges every block into a clean,
 * non-overlapping grid. The delete/grip sit at the top-left, tucked below the
 * frame's name heading (which lives above the top edge), so they never collide.
 */
function FrameChrome({ shape }: { shape: TLFrameShape }) {
  const editor = useEditor()
  const isHovered = useValue('frame-hovered', () => editor.getHoveredShapeId() === shape.id, [editor, shape.id])
  const isSelected = useValue('frame-selected', () => editor.getSelectedShapeIds().includes(shape.id), [editor, shape.id])
  // Each affordance lives slightly outside the frame box, so any one of them being
  // hovered must keep the whole set visible (tldraw's own hover signal can drop).
  const [chromeHover, setChromeHover] = useState(false)
  const show = isHovered || isSelected || chromeHover

  return (
    <HTMLContainer className="frame-chrome">
      <DeleteButton editor={editor} id={shape.id} show={show} onHoverChange={setChromeHover} className="frame-trash" />

      <DragHandle editor={editor} id={shape.id} show={show} onHoverChange={setChromeHover} className="frame-grip" />

      <TidyButton editor={editor} id={shape.id} show={show} onHoverChange={setChromeHover} className="frame-tidy" />
    </HTMLContainer>
  )
}

/**
 * The frame's "tidy layout" affordance — same circular chrome as the delete
 * button (neutral hover, not red), tucked against the top-right edge. Clicking it
 * re-flows every block in the frame into a clean, non-overlapping column grid and
 * persists the new positions, so the AI's stacked-up cards snap apart and stay
 * that way across reloads. See backendSync.tidyFrame.
 */
function TidyButton({
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
      className={`shape-tidy${show ? ' show' : ''}${className ? ` ${className}` : ''}`}
      title="Tidy layout — arrange blocks so they don't overlap"
      aria-label="Tidy layout"
      // Don't let the press start a canvas drag/select on the frame underneath.
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
      onMouseEnter={() => onHoverChange?.(true)}
      onMouseLeave={() => onHoverChange?.(false)}
      onClick={(e) => {
        e.stopPropagation()
        tidyFrame(editor, id)
      }}
    >
      <TidyIcon />
    </button>
  )
}

function TidyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="11" rx="1.5" />
      <rect x="3" y="13" width="7" height="8" rx="1.5" />
      <rect x="14" y="17" width="7" height="4" rx="1.5" />
    </svg>
  )
}
