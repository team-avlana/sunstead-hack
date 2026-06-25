import { FrameShapeUtil, SVGContainer, type TLFrameShape } from 'tldraw'
import { getSquirclePath } from '@/lib/squircle'

/** iOS-style corner radius (page units) for canvas frames. */
const FRAME_RADIUS = 24
const FRAME_SMOOTHING = 0.6

/**
 * Rainy's frame: tldraw's built-in flow container, reskinned to match the app —
 * an iOS squircle body (continuous corners) with a soft tinted drop shadow and a
 * clean hairline, instead of the stock white box + hard border.
 *
 * We extend the built-in util so all of its behaviour (geometry, child clipping,
 * the editable heading) is inherited untouched; we only swap the painted body.
 * The original `<rect class="tl-frame__body">` is hidden in CSS — see globals.css.
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
      </>
    )
  }

  override indicator(shape: TLFrameShape) {
    const { w, h } = shape.props
    return <path d={getSquirclePath(w, h, FRAME_RADIUS, FRAME_SMOOTHING)} />
  }
}
