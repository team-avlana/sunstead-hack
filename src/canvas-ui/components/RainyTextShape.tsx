'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Geometry2d,
  HTMLContainer,
  Rectangle2d,
  RecordProps,
  ShapeUtil,
  T,
  TLResizeInfo,
  TLShape,
  TLShapeId,
  resizeBox,
  useEditor,
  useValue,
} from 'tldraw'
import { EditorContent, useEditor as useTiptap } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import {
  RAINY_TEXT,
  TEXT_FORMAT_OPTIONS,
  type TextFormat,
  inferFormat,
  restructure,
  setDefaultTextFormat,
} from '@/lib/blockTypes'
import { relayoutFrame } from '@/lib/frameLayout'
import { DeleteButton, DragHandle } from './ShapeChrome'

/**
 * Rainy text block — a markdown-aware card.
 *
 * Markdown is formatted *as you type* (tiptap StarterKit input rules: `# `, `**b**`,
 * `- `, `> `, `` `code` `` …) and rendered with the compiled aesthetic instantly.
 * Progressive-disclosure chrome:
 *   - hover (not editing) → main actions: "Aa" + copy
 *   - "Aa" toggled → a format menu (Plain text / Title + text / Title + subtitle +
 *     text). Picking a format restructures the block (non-destructively) and is
 *     remembered as the default for newly-created text blocks.
 *
 * The format taxonomy + (de)structuring logic lives in `lib/blockTypes` so the
 * adaptive sidebar can drive the same transforms from outside the editor.
 */
export { RAINY_TEXT } from '@/lib/blockTypes'

/** DEBUG: tint the hover/active area so we can see what triggers the menu. Flip off when happy. */
const DEBUG_HOVER = false

declare module 'tldraw' {
  export interface TLGlobalShapePropsMap {
    [RAINY_TEXT]: { w: number; h: number; html: string }
  }
}

export type RainyTextShape = TLShape<typeof RAINY_TEXT>

// Sized to read as a sibling of the video block: same width as a video card
// (360) and the height of an analysed/expanded video (see lib/blockTypes `dims`,
// status 'analysed' → h 332), so text + video cards share one visual footprint.
const LARGE = { w: 360, h: 332 }
const SMALL_MAX_H = 150
/** Auto-height floor. The card hugs its content — AI-generated text and the
 * user's own typing both grow/shrink it instead of scrolling inside a fixed box
 * — never collapsing below this. Width stays put (it matches the video block);
 * only height tracks the content. Re-flowing the enclosing frame so siblings
 * don't overlap is delegated to lib/frameLayout `relayoutFrame`. */
const MIN_H = 56

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

  // tldraw paints the selection border + hover indicator on a *canvas overlay*
  // that sits above the shapes layer (z 500 vs 300), so it always covers the
  // card's own chrome (the trash button, the toolbar) no matter their z-index.
  // We opt this shape out of both — the empty indicator path draws nothing and
  // `hideSelectionBoundsFg` drops the bounding-box stroke — and redraw the
  // rounded selection/hover border *on the card itself* (see `.rainy-text-card`
  // `.is-selected`/`.is-hovered` in globals.css). The border then lives in the
  // HTML layer beneath the trash, so the trash sits cleanly on top. Resize
  // handles are unaffected and still render.
  override hideSelectionBoundsFg() {
    return true
  }

  getIndicatorPath() {
    return new Path2D()
  }
}

// ---------------------------------------------------------------------------
// Block format menu — the in-canvas "Aa" picker.
// Taxonomy + transforms (plain / title / title-sub) live in lib/blockTypes.
// ---------------------------------------------------------------------------

/** Tiny structural preview per format, for the "Aa" menu rows. */
const FORMAT_PREVIEW: Record<TextFormat, ReactNode> = {
  plain: <><i className="b" /><i className="b2" /></>,
  title: <><i className="t" /><i className="b" /><i className="b2" /></>,
  'title-sub': <><i className="t" /><i className="s" /><i className="b2" /></>,
}

const FORMATS = TEXT_FORMAT_OPTIONS.map((o) => ({ ...o, preview: FORMAT_PREVIEW[o.id] }))

// ---------------------------------------------------------------------------
// Per-node placeholders (Title / Subtitle / Write something…) for empty blocks.
// A tiny ProseMirror plugin, so we avoid pulling in @tiptap/extension-placeholder.
// ---------------------------------------------------------------------------

const TextPlaceholder = Extension.create({
  name: 'rainyTextPlaceholder',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('rainyTextPlaceholder'),
        props: {
          decorations: (state) => {
            const decos: Decoration[] = []
            state.doc.descendants((node, pos) => {
              if (!node.isTextblock || node.content.size > 0) return
              const text =
                node.type.name === 'heading'
                  ? node.attrs.level === 1
                    ? 'Title'
                    : node.attrs.level === 2
                      ? 'Subtitle'
                      : 'Heading'
                  : 'Write something…'
              decos.push(
                Decoration.node(pos, pos + node.nodeSize, { class: 'is-empty', 'data-placeholder': text }),
              )
            })
            return DecorationSet.create(state.doc, decos)
          },
        },
      }),
    ]
  },
})

function RainyText({ shape }: { shape: RainyTextShape }) {
  const editor = useEditor()
  const isEditing = useValue('editing', () => editor.getEditingShapeId() === shape.id, [editor, shape.id])
  const isHovered = useValue('hovered', () => editor.getHoveredShapeId() === shape.id, [editor, shape.id])
  // We render our own selection/hover border on the card (tldraw's overlay
  // indicator is suppressed for this shape — see the util above).
  const isSelected = useValue('selected', () => editor.getSelectedShapeIds().includes(shape.id), [editor, shape.id])
  const [formatOpen, setFormatOpen] = useState(false)
  const [zoneHover, setZoneHover] = useState(false)

  const saveTimer = useRef<number | undefined>(undefined)
  const cardRef = useRef<HTMLDivElement>(null)

  const tiptap = useTiptap({
    immediatelyRender: false,
    editable: false,
    extensions: [
      StarterKit.configure({
        // keep it focused; defaults already give markdown input rules
        heading: { levels: [1, 2, 3] },
      }),
      TextPlaceholder,
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
    const raf = requestAnimationFrame(() => {
      // Fresh templated cards open with an empty title — land the caret there;
      // otherwise pick up where the content ends.
      const first = tiptap.state.doc.firstChild
      const emptyTitle = first?.type.name === 'heading' && first.content.size === 0
      tiptap.commands.focus(emptyTitle ? 'start' : 'end')
    })
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

  // Auto-fit the card's height to its content. We measure the prose's natural
  // height (it lives in the DOM regardless of the card's clipped box) and patch
  // shape.props.h to match — so AI-generated text and the user's typing both
  // resize the card live. A ResizeObserver catches every reflow (typing, an
  // external html update, or a width change). Height patches are history-ignored
  // (they never land in undo). After resizing, we re-flow the enclosing frame (if
  // any) so siblings don't overlap and the frame grows/shrinks to fit. Width is
  // left untouched.
  useEffect(() => {
    if (!tiptap) return
    const prose = tiptap.view.dom as HTMLElement
    const fit = () => {
      const card = cardRef.current
      if (!card) return
      // When a card scrolls off-screen tldraw *culls* it by setting display:none on
      // its container (the component stays mounted). That collapses scrollHeight to
      // 0, and a naive measure here would shrink the card to MIN_H and fire a frame
      // relayout — so every sibling jumps around as you pan, then jumps back when
      // the card returns. Bail while hidden (offsetParent is null under display:none);
      // the ResizeObserver fires again with the real height once it's visible. This
      // keeps culled cards at their true size, so re-entry is a no-op (no relayout).
      if (card.offsetParent === null) return
      const cs = getComputedStyle(card)
      const padV = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
      const target = Math.max(MIN_H, Math.ceil(prose.scrollHeight + padV))
      const cur = editor.getShape<RainyTextShape>(shape.id)
      if (!cur || Math.abs(target - cur.props.h) <= 1) return
      // Auto-fit height is derived, not a user edit — apply it as a `remote` change
      // (history-ignored) so it isn't pushed to Postgres. relayoutFrame does the same.
      editor.store.mergeRemoteChanges(() =>
        editor.run(() => editor.updateShape({ id: shape.id, type: RAINY_TEXT, props: { h: target } }), {
          history: 'ignore',
        }),
      )
      if (cur.parentId) relayoutFrame(editor, cur.parentId as TLShapeId)
    }
    const ro = new ResizeObserver(fit)
    ro.observe(prose)
    fit()
    return () => ro.disconnect()
  }, [tiptap, editor, shape.id])

  const isSmall = shape.props.h < SMALL_MAX_H
  // Active area = the whole dome (card + space above), via the .rt-zone hover.
  const showMain = zoneHover || isHovered || isEditing || formatOpen
  // The format menu is only revealed once the user clicks "Aa".
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
  // Keep selection/focus when clicking a menu button.
  const hold = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }

  // Current block format (inferred from the leading headings) + the menu action
  // that restructures the block into the chosen format. The choice is remembered
  // as the default for any newly-created text block.
  const currentFormat = inferFormat(shape.props.html || '')
  const applyFormat = (next: TextFormat) => {
    const curHtml = isEditing && tiptap ? tiptap.getHTML() : shape.props.html || ''
    const nextHtml = restructure(curHtml, next)
    setDefaultTextFormat(next)
    setFormatOpen(false)
    if (nextHtml === curHtml) return
    editor.updateShape({ id: shape.id, type: RAINY_TEXT, props: { html: nextHtml } })
    // While editing, the external-sync effect is suppressed — push the new
    // structure into ProseMirror directly and re-seat the caret.
    if (isEditing && tiptap) {
      tiptap.commands.setContent(nextHtml, { emitUpdate: false })
      requestAnimationFrame(() => {
        const first = tiptap.state.doc.firstChild
        const emptyTitle = first?.type.name === 'heading' && first.content.size === 0
        tiptap.commands.focus(emptyTitle ? 'start' : 'end')
      })
    }
  }

  return (
    <HTMLContainer className="rainy-text-host">
      <div
        className={`rt-zone${DEBUG_HOVER ? ' debug' : ''}${showMain ? ' on' : ''}`}
        onMouseEnter={() => setZoneHover(true)}
        onMouseLeave={() => setZoneHover(false)}
      >
        <DeleteButton editor={editor} id={shape.id} show={showMain} />
        <DragHandle editor={editor} id={shape.id} show={showMain} />

        <div
          ref={cardRef}
          className={`rainy-text-card${isSmall ? ' is-small' : ''}${isEditing ? ' is-editing' : ''}${
            isSelected ? ' is-selected' : isHovered ? ' is-hovered' : ''
          }`}
        >
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
          <div className={`rt-menu${showFormat ? ' show' : ''}`} role="menu">
            {FORMATS.map((f) => (
              <button
                key={f.id}
                role="menuitemradio"
                aria-checked={currentFormat === f.id}
                className={`rt-menu-item${currentFormat === f.id ? ' on' : ''}`}
                onMouseDown={hold}
                onClick={() => applyFormat(f.id)}
                title={f.label}
              >
                <span className="rt-menu-preview">{f.preview}</span>
                <span className="rt-menu-label">{f.label}</span>
                {currentFormat === f.id && (
                  <span className="rt-menu-check">
                    <CheckIcon />
                  </span>
                )}
              </button>
            ))}
          </div>

          <div className="rt-main">
            <button className={`rt-pill${showFormat ? ' on' : ''}`} onMouseDown={hold} onClick={() => setFormatOpen((o) => !o)} title="Text format">
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

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}
