'use client'

import {
  Geometry2d,
  HTMLContainer,
  Rectangle2d,
  RecordProps,
  ShapeUtil,
  T,
  TLResizeInfo,
  TLShape,
  resizeBox,
  useEditor,
  useValue,
} from 'tldraw'
import { useEffect, useState } from 'react'
import s from './ImageBlock.module.css'
import { IMAGE_BLOCK } from '@/lib/blockTypes'
import { DeleteButton, DragHandle } from './ShapeChrome'

/**
 * Image Block — a storyboard / shot-list panel.
 *
 * Renders one image (a `src` resolved upstream to a loadable URL: a video frame
 * `/frames/{id}`, an AI-generated storyboard panel `/api/storyboard/{id}`, a
 * data: URL, or any absolute http(s) image) with an optional caption + shot-type
 * badge. This is what makes the storyboarding and shot-list MCP flows visible on
 * the canvas: those tools emit payload elements of type:"image", which
 * backendCanvas maps onto this shape.
 *
 * Three display states: a loading skeleton until the image decodes, the image
 * itself, and a graceful broken-frame placeholder (frames live on the worker
 * host and can 404) — the caption stays legible in every state so a missing
 * image still reads as a labelled scene.
 *
 * The taxonomy (IMAGE_BLOCK, ImageData) lives in lib/blockTypes so the renderer
 * and the artifact→shape mapping share one source of truth.
 */
export { IMAGE_BLOCK } from '@/lib/blockTypes'

declare module 'tldraw' {
  export interface TLGlobalShapePropsMap {
    [IMAGE_BLOCK]: { w: number; h: number; src: string; caption: string; shotType: string }
  }
}

export type ImageBlockShape = TLShape<typeof IMAGE_BLOCK>

export class ImageBlockShapeUtil extends ShapeUtil<ImageBlockShape> {
  static override type = IMAGE_BLOCK
  static override props: RecordProps<ImageBlockShape> = {
    w: T.number,
    h: T.number,
    src: T.string,
    caption: T.string,
    shotType: T.string,
  }

  getDefaultProps(): ImageBlockShape['props'] {
    return { w: 360, h: 224, src: '', caption: '', shotType: '' }
  }

  override canEdit() {
    return false
  }
  override canResize() {
    return true
  }
  override isAspectRatioLocked() {
    return false
  }

  getGeometry(shape: ImageBlockShape): Geometry2d {
    return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true })
  }

  override onResize(shape: ImageBlockShape, info: TLResizeInfo<ImageBlockShape>) {
    return resizeBox(shape, info)
  }

  component(shape: ImageBlockShape) {
    return <ImageBlock shape={shape} />
  }

  getIndicatorPath(shape: ImageBlockShape) {
    const path = new Path2D()
    const r = 18
    if (typeof path.roundRect === 'function') path.roundRect(0, 0, shape.props.w, shape.props.h, r)
    else path.rect(0, 0, shape.props.w, shape.props.h)
    return path
  }
}

// ── React render ───────────────────────────────────────────────────────────

function ImageBlock({ shape }: { shape: ImageBlockShape }) {
  const editor = useEditor()
  const { src, caption, shotType } = shape.props

  // Hover/selection drives the delete affordance (mirrors the video block).
  const isHovered = useValue('hovered', () => editor.getHoveredShapeId() === shape.id, [editor, shape.id])
  const isSelected = useValue('selected', () => editor.getSelectedShapeIds().includes(shape.id), [editor, shape.id])
  const [trashHover, setTrashHover] = useState(false)

  // Per-src load lifecycle: 'loading' → 'ready' | 'error'. Reset when src changes
  // (a reconcile can swap the underlying frame/panel for this element).
  const [load, setLoad] = useState<'loading' | 'ready' | 'error'>(src ? 'loading' : 'error')
  useEffect(() => {
    setLoad(src ? 'loading' : 'error')
  }, [src])

  const showChrome = isHovered || isSelected || trashHover

  return (
    <HTMLContainer>
      {/* host isolates the appear-animation aurora behind the card */}
      <div className={s.host}>
        <div className={s.card}>
          <div className={s.media}>
            {src && load !== 'error' ? (
              <img
                src={src}
                alt={caption || 'storyboard panel'}
                className={s.img}
                draggable={false}
                onLoad={() => setLoad('ready')}
                onError={() => setLoad('error')}
              />
            ) : null}

            {load === 'loading' ? <div className={s.skeleton} /> : null}

            {load === 'error' ? (
              <div className={s.broken}>
                <ImageGlyph />
                <span>{src ? 'Image unavailable' : 'No image'}</span>
              </div>
            ) : null}

            {shotType ? <span className={s.shotBadge}>{shotType}</span> : null}
          </div>

          {caption ? (
            <div className={s.caption}>
              <span className={s.captionText}>{caption}</span>
            </div>
          ) : null}
        </div>
      </div>

      <DeleteButton
        editor={editor}
        id={shape.id}
        show={showChrome}
        onHoverChange={setTrashHover}
        className="ib-trash"
      />

      <DragHandle
        editor={editor}
        id={shape.id}
        show={showChrome}
        onHoverChange={setTrashHover}
        className="ib-grip"
      />
    </HTMLContainer>
  )
}

function ImageGlyph() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <circle cx="8.5" cy="8.5" r="1.6" />
      <path d="M21 15l-5-5L5 21" />
    </svg>
  )
}
