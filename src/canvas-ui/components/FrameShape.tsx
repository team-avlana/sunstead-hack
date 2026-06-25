'use client'

import { useState } from 'react'
import {
  FrameShapeUtil,
  HTMLContainer,
  SVGContainer,
  useEditor,
  useValue,
  type TLFrameShape,
} from 'tldraw'
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
 * The frame's hover chrome — just the shared delete button for now. It sits at
 * the top-left, tucked below the frame's name heading (which lives above the top
 * edge), so the two never collide.
 */
function FrameChrome({ shape }: { shape: TLFrameShape }) {
  const editor = useEditor()
  const isHovered = useValue('frame-hovered', () => editor.getHoveredShapeId() === shape.id, [editor, shape.id])
  const isSelected = useValue('frame-selected', () => editor.getSelectedShapeIds().includes(shape.id), [editor, shape.id])
  const [trashHover, setTrashHover] = useState(false)

  return (
    <HTMLContainer className="frame-chrome">
      <DeleteButton
        editor={editor}
        id={shape.id}
        show={isHovered || isSelected || trashHover}
        onHoverChange={setTrashHover}
        className="frame-trash"
      />

      <DragHandle
        editor={editor}
        id={shape.id}
        show={isHovered || isSelected || trashHover}
        onHoverChange={setTrashHover}
        className="frame-grip"
      />
    </HTMLContainer>
  )
}
