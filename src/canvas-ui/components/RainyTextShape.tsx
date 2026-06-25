'use client'

import { useEffect, useRef, useState } from 'react'
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
import { EditorContent, useEditor as useTiptap } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'

/**
 * Rainy text block — a markdown-aware card.
 *
 * Markdown is formatted *as you type* (tiptap StarterKit input rules: `# `, `**b**`,
 * `- `, `> `, `` `code` `` …) and rendered with the compiled aesthetic instantly.
 * Progressive-disclosure chrome:
 *   - hover (not editing) → main actions: "Aa" + copy
 *   - editing / Aa toggled → formatting bar: B I U </> and "Aa" highlighted
 */
export const RAINY_TEXT = 'rainy-text' as const

/** DEBUG: tint the hover/active area so we can see what triggers the menu. Flip off when happy. */
const DEBUG_HOVER = false

declare module 'tldraw' {
  export interface TLGlobalShapePropsMap {
    [RAINY_TEXT]: { w: number; h: number; html: string }
  }
}

export type RainyTextShape = TLShape<typeof RAINY_TEXT>

const LARGE = { w: 440, h: 260 }
const SMALL_MAX_H = 150

export class RainyTextShapeUtil extends ShapeUtil<RainyTextShape> {
  static override type = RAINY_TEXT
  static override props: RecordProps<RainyTextShape> = {
    w: T.number,
    h: T.number,
    html: T.string,
  }

  getDefaultProps(): RainyTextShape['props'] {
    return { w: LARGE.w, h: LARGE.h, html: '' }
  }

  override canEdit() {
    return true
  }
  override canResize() {
    return true
  }
  override isAspectRatioLocked() {
    return false
  }

  getGeometry(shape: RainyTextShape): Geometry2d {
    return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true })
  }

  override onResize(shape: RainyTextShape, info: TLResizeInfo<RainyTextShape>) {
    return resizeBox(shape, info)
  }

  component(shape: RainyTextShape) {
    return <RainyText shape={shape} />
  }

  getIndicatorPath(shape: RainyTextShape) {
    const path = new Path2D()
    const r = 16
    if (typeof path.roundRect === 'function') {
      path.roundRect(0, 0, shape.props.w, shape.props.h, r)
    } else {
      path.rect(0, 0, shape.props.w, shape.props.h)
    }
    return path
  }
}

function RainyText({ shape }: { shape: RainyTextShape }) {
  const editor = useEditor()
  const isEditing = useValue('editing', () => editor.getEditingShapeId() === shape.id, [editor, shape.id])
  const isHovered = useValue('hovered', () => editor.getHoveredShapeId() === shape.id, [editor, shape.id])
  const [formatOpen, setFormatOpen] = useState(false)
  const [zoneHover, setZoneHover] = useState(false)

  const saveTimer = useRef<number | undefined>(undefined)

  const tiptap = useTiptap({
    immediatelyRender: false,
    editable: false,
    extensions: [
      StarterKit.configure({
        // keep it focused; defaults already give markdown input rules
        heading: { levels: [1, 2, 3] },
      }),
    ],
    content: shape.props.html || '',
    editorProps: { attributes: { class: 'rainy-text-prose' } },
    onUpdate: ({ editor: ed }) => {
      const html = ed.isEmpty ? '' : ed.getHTML()
      window.clearTimeout(saveTimer.current)
      saveTimer.current = window.setTimeout(() => {
        editor.updateShape({ id: shape.id, type: RAINY_TEXT, props: { html } })
      }, 250)
    },
  })

  // Enter/leave edit mode → toggle editability + focus.
  // Focus is the whole ballgame: tldraw only stops swallowing keystrokes
  // (letters, Backspace, …) while `document.activeElement.isContentEditable`.
  // If the ProseMirror DOM ever loses focus, typing "breaks" and Backspace
  // deletes the card. So we grab focus on enter (after the DOM settles, so
  // tldraw can't refocus its container under us) and re-grab it on any click.
  useEffect(() => {
    if (!tiptap) return
    tiptap.setEditable(isEditing)
    if (!isEditing) {
      setFormatOpen(false)
      return
    }
    const raf = requestAnimationFrame(() => tiptap.commands.focus('end'))
    return () => cancelAnimationFrame(raf)
  }, [isEditing, tiptap])

  // Pull in external (agent / undo) changes, but never stomp the user mid-edit.
  useEffect(() => {
    if (!tiptap || isEditing) return
    const next = shape.props.html || ''
    if (tiptap.getHTML() !== next && !(tiptap.isEmpty && next === '')) {
      tiptap.commands.setContent(next, { emitUpdate: false })
    }
  }, [shape.props.html, isEditing, tiptap])

  useEffect(() => () => window.clearTimeout(saveTimer.current), [])

  const isSmall = shape.props.h < SMALL_MAX_H
  // Active area = the whole dome (card + space above), via the .rt-zone hover.
  const showMain = zoneHover || isHovered || isEditing || formatOpen
  // Formatting tools (B/I/U/code) are only revealed once the user clicks "Aa".
  const showFormat = formatOpen

  // Stop tldraw from treating editor/toolbar interaction as a canvas gesture,
  // and make sure clicking anywhere in the text re-arms ProseMirror's focus.
  const stop = (e: React.PointerEvent) => {
    if (!isEditing) return
    e.stopPropagation()
    if (tiptap && !tiptap.view.hasFocus()) tiptap.commands.focus()
  }
  // Keep keystrokes from bubbling to tldraw's document-level handler while editing.
  const stopKeys = (e: React.KeyboardEvent) => {
    if (isEditing) e.stopPropagation()
  }
  // Keep selection/focus when clicking a toolbar button.
  const hold = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }

  const cmd = (fn: () => void) => () => {
    if (!isEditing) editor.setEditingShape(shape.id)
    fn()
  }

  return (
    <HTMLContainer className="rainy-text-host">
      <div
        className={`rt-zone${DEBUG_HOVER ? ' debug' : ''}${showMain ? ' on' : ''}`}
        onMouseEnter={() => setZoneHover(true)}
        onMouseLeave={() => setZoneHover(false)}
      >
        <div className={`rainy-text-card${isSmall ? ' is-small' : ''}${isEditing ? ' is-editing' : ''}`}>
          <div
            className="rainy-text-content"
            onPointerDown={stop}
            onPointerUp={stop}
            onKeyDown={stopKeys}
            style={{ pointerEvents: isEditing ? 'all' : 'none' }}
          >
            <EditorContent editor={tiptap} />
          </div>
        </div>

        <div className={`rt-actions${showMain ? ' show' : ''}`} onPointerDown={(e) => e.stopPropagation()}>
          <div className={`rt-format${showFormat ? ' show' : ''}`}>
          <button className={tiptap?.isActive('bold') ? 'on' : ''} onMouseDown={hold} onClick={cmd(() => tiptap?.chain().focus().toggleBold().run())} title="Bold">
            <b>B</b>
          </button>
          <button className={tiptap?.isActive('italic') ? 'on' : ''} onMouseDown={hold} onClick={cmd(() => tiptap?.chain().focus().toggleItalic().run())} title="Italic">
            <i>I</i>
          </button>
          <button className={tiptap?.isActive('underline') ? 'on' : ''} onMouseDown={hold} onClick={cmd(() => tiptap?.chain().focus().toggleUnderline().run())} title="Underline">
            <u>U</u>
          </button>
          <button className={tiptap?.isActive('code') ? 'on' : ''} onMouseDown={hold} onClick={cmd(() => tiptap?.chain().focus().toggleCode().run())} title="Code">
            <span className="mono">&lt;/&gt;</span>
          </button>
        </div>

        <div className="rt-main">
          <button className={`rt-pill${showFormat ? ' on' : ''}`} onMouseDown={hold} onClick={() => setFormatOpen((o) => !o)} title="Text styles">
            Aa <span className="caret">⌄</span>
          </button>
          <button className="rt-icon" onMouseDown={hold} onClick={() => editor.duplicateShapes([shape.id], { x: 28, y: 28 })} title="Duplicate">
            <CopyIcon />
          </button>
        </div>
        </div>
      </div>
    </HTMLContainer>
  )
}

function CopyIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  )
}
