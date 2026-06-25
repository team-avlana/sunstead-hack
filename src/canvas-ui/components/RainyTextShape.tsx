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
  resizeBox,
  useEditor,
  useValue,
} from 'tldraw'
import { EditorContent, useEditor as useTiptap } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

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

// ---------------------------------------------------------------------------
// Block format — plain / title+text / title+subtitle+text
// ---------------------------------------------------------------------------

export type TextFormat = 'plain' | 'title' | 'title-sub'

/** Which structural slots each format carries above the body. */
const FORMAT_SLOTS: Record<TextFormat, { title: boolean; subtitle: boolean }> = {
  plain: { title: false, subtitle: false },
  title: { title: true, subtitle: false },
  'title-sub': { title: true, subtitle: true },
}

const FORMAT_KEY = 'rainy:textFormat'

/** The last format the user picked — the default for newly-created text blocks. */
export function getDefaultTextFormat(): TextFormat {
  if (typeof window === 'undefined') return 'title'
  const v = window.localStorage.getItem(FORMAT_KEY)
  return v === 'plain' || v === 'title' || v === 'title-sub' ? v : 'title'
}
export function setDefaultTextFormat(f: TextFormat) {
  if (typeof window !== 'undefined') window.localStorage.setItem(FORMAT_KEY, f)
}

/** Empty starting content for a format: headings first, then a body line. */
export function templateHtml(f: TextFormat): string {
  const slots = FORMAT_SLOTS[f]
  return `${slots.title ? '<h1></h1>' : ''}${slots.subtitle ? '<h2></h2>' : ''}<p></p>`
}

/** Top-level element nodes of an HTML fragment (browser-only). */
function topLevelNodes(html: string): HTMLElement[] {
  if (typeof document === 'undefined') return []
  const tpl = document.createElement('template')
  tpl.innerHTML = html || ''
  return Array.from(tpl.content.children) as HTMLElement[]
}

/** Does an inline HTML fragment carry any real text? */
function hasText(inner: string): boolean {
  return inner.replace(/<br\s*\/?>/gi, '').replace(/<[^>]*>/g, '').trim().length > 0
}

/** Infer a block's format from its leading headings (H1 = title, H1+H2 = +subtitle). */
export function inferFormat(html: string): TextFormat {
  const nodes = topLevelNodes(html)
  const h1 = nodes[0]?.tagName === 'H1'
  const h2 = nodes[1]?.tagName === 'H2'
  if (h1 && h2) return 'title-sub'
  if (h1) return 'title'
  return 'plain'
}

/**
 * Restructure a block's HTML into the target format, preserving all text:
 * added slots come in empty (placeholder-ready); removed slots demote to body
 * paragraphs so nothing is lost.
 */
export function restructure(html: string, next: TextFormat): string {
  const cur = inferFormat(html)
  if (cur === next) return html
  const nodes = topLevelNodes(html)
  const from = FORMAT_SLOTS[cur]
  const to = FORMAT_SLOTS[next]

  let i = 0
  const titleInner = from.title ? nodes[i++]?.innerHTML ?? '' : ''
  const subtitleInner = from.subtitle ? nodes[i++]?.innerHTML ?? '' : ''
  const bodyEls = nodes.slice(i)

  const head: string[] = []
  if (to.title) head.push(`<h1>${titleInner}</h1>`)
  if (to.subtitle) head.push(`<h2>${subtitleInner}</h2>`)

  const body: string[] = []
  // Demote dropped title/subtitle text into the body rather than discard it.
  if (from.title && !to.title && hasText(titleInner)) body.push(`<p>${titleInner}</p>`)
  if (from.subtitle && !to.subtitle && hasText(subtitleInner)) body.push(`<p>${subtitleInner}</p>`)
  for (const el of bodyEls) body.push(el.outerHTML)
  if (body.length === 0) body.push('<p></p>')

  return head.join('') + body.join('')
}

/** The three formats offered in the "Aa" menu, with a tiny structural preview. */
const FORMATS: { id: TextFormat; label: string; preview: ReactNode }[] = [
  { id: 'plain', label: 'Plain text', preview: <><i className="b" /><i className="b2" /></> },
  { id: 'title', label: 'Title + text', preview: <><i className="t" /><i className="b" /><i className="b2" /></> },
  { id: 'title-sub', label: 'Title + subtitle + text', preview: <><i className="t" /><i className="s" /><i className="b2" /></> },
]

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
