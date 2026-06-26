'use client'

import { useEffect, useState } from 'react'
import {
  FrameShapeUtil,
  HTMLContainer,
  SVGContainer,
  useEditor,
  useValue,
  type TLFrameShape,
  type TLShape,
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

  // Both of tldraw's overlay selection visuals are drawn ABOVE the shape layer, so
  // they painted on top of the frame's own chrome (the trash button) — which looked
  // broken. We drop the rectangular bounds stroke (hideSelectionBoundsFg) AND the
  // overlay indicator squircle (empty `indicator`), and instead paint the
  // selection/hover outline on the frame BODY itself (see FrameBody → the squircle
  // stroke recolours), which sits in the shape layer BENEATH the chrome. Resize
  // handles still render (gated separately by canResize/hideResizeHandles). Mirrors
  // the text card.
  override hideSelectionBoundsFg() {
    return true
  }

  override component(shape: TLFrameShape) {
    return (
      <>
        <FrameBody shape={shape} />
        {/* Inherited body rect (hidden) + the editable frame heading. */}
        {super.component(shape)}
        <FrameChrome shape={shape} />
      </>
    )
  }

  override indicator() {
    return <g />
  }
}

/** The frame's painted body (the iOS squircle) plus its selection/hover outline,
 * drawn on the body in the shape layer so the outline never paints over the
 * chrome. Reactive to selection/hover via the editor signals. */
function FrameBody({ shape }: { shape: TLFrameShape }) {
  const editor = useEditor()
  const { w, h } = shape.props
  const d = getSquirclePath(w, h, FRAME_RADIUS, FRAME_SMOOTHING)
  const state = useValue(
    'frame-body-state',
    () => {
      if (editor.getSelectedShapeIds().includes(shape.id)) return 'is-selected'
      if (editor.getHoveredShapeId() === shape.id) return 'is-hovered'
      return ''
    },
    [editor, shape.id],
  )
  return (
    <SVGContainer className={`rainy-frame-svg ${state}`}>
      <path className="rainy-frame-body" d={d} />
    </SVGContainer>
  )
}

/**
 * The frame's hover chrome:
 *   - the delete button at the **top-left corner** (Apple's convention: destructive
 *     action lives top-left), and the drag grip on the left edge, and
 *   - a single floating **Auto-arrange button above the frame** — so the tidy
 *     action reads as a clear button on top of the frame instead of a stray icon at
 *     the corner.
 *
 * The Auto-arrange button floats outside the frame's top edge (clear of the name
 * heading on the left + the selection handles at the corners). All of it reveals
 * when the frame OR any of its contents is hovered, when the frame is selected, or
 * while the pointer is on the chrome — with a short linger so moving from the frame
 * up to the button never drops it (the same "hover area that extends beyond the
 * element" the text card uses).
 */
function FrameChrome({ shape }: { shape: TLFrameShape }) {
  const editor = useEditor()
  // Hover counts for the frame itself AND any block inside it, so the panel stays
  // up while the pointer is anywhere over the frame's region/contents.
  const isHovered = useValue(
    'frame-hovered',
    () => {
      const h = editor.getHoveredShapeId()
      if (!h) return false
      return h === shape.id || editor.getShape(h)?.parentId === shape.id
    },
    [editor, shape.id],
  )
  const isSelected = useValue('frame-selected', () => editor.getSelectedShapeIds().includes(shape.id), [editor, shape.id])
  // The panel/grip live outside the frame box, so keep them alive while hovered
  // (tldraw's own hover signal drops once the pointer leaves the geometry).
  const [chromeHover, setChromeHover] = useState(false)
  const [show, setShow] = useState(false)
  const want = isHovered || isSelected || chromeHover
  useEffect(() => {
    if (want) {
      setShow(true)
      return
    }
    const t = window.setTimeout(() => setShow(false), 160)
    return () => window.clearTimeout(t)
  }, [want])

  const stop = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }

  return (
    <HTMLContainer className="frame-chrome">
      {/* Delete: top-left corner (Apple convention for destructive actions). */}
      <DeleteButton editor={editor} id={shape.id} show={show} onHoverChange={setChromeHover} className="frame-trash" />

      <DragHandle editor={editor} id={shape.id} show={show} onHoverChange={setChromeHover} className="frame-grip" />

      {/* Auto-arrange: a single floating button above the frame's top edge. */}
      <button
        className={`frame-arrange${show ? ' show' : ''}`}
        title="Auto-arrange — tidy the blocks so they don't overlap"
        aria-label="Auto-arrange blocks"
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={stop}
        onMouseEnter={() => setChromeHover(true)}
        onMouseLeave={() => setChromeHover(false)}
        onClick={(e) => {
          e.stopPropagation()
          tidyFrame(editor, shape.id)
        }}
      >
        <TidyIcon />
        <span className="frame-arrange-label">Auto-arrange</span>
      </button>
    </HTMLContainer>
  )
}

function TidyIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="11" rx="1.5" />
      <rect x="3" y="13" width="7" height="8" rx="1.5" />
      <rect x="14" y="17" width="7" height="4" rx="1.5" />
    </svg>
  )
}

