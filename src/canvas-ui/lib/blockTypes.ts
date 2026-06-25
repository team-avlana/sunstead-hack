/**
 * Block taxonomy — the single source of truth for the *kinds* of blocks the
 * canvas understands and the *variants* each kind can take.
 *
 * Deliberately framework-free: no tldraw, tiptap, or React imports, so it can be
 * shared by the shape utils (which render inside <Tldraw>) AND the adaptive
 * sidebar (which lives outside the editor and must stay SSR-safe). The shapes
 * own *rendering*; this module owns *what the variants are and how to move
 * between them*.
 *
 *   Text block  → format:  plain | title | title-sub
 *   Video block → detail:  compact | expanded | full   (+ analysis status)
 */

// ===========================================================================
// Text blocks
// ===========================================================================

export const RAINY_TEXT = 'rainy-text' as const

export type TextFormat = 'plain' | 'title' | 'title-sub'

/** Which structural slots each format carries above the body. */
const FORMAT_SLOTS: Record<TextFormat, { title: boolean; subtitle: boolean }> = {
  plain: { title: false, subtitle: false },
  title: { title: true, subtitle: false },
  'title-sub': { title: true, subtitle: true },
}

/** The text formats offered everywhere (sidebar inspector + in-canvas "Aa" menu). */
export const TEXT_FORMAT_OPTIONS: { id: TextFormat; label: string }[] = [
  { id: 'plain', label: 'Plain text' },
  { id: 'title', label: 'Title + text' },
  { id: 'title-sub', label: 'Title + subtitle + text' },
]

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

/** Whether a text block carries any visible text at all (empty cards). */
export function textIsEmpty(html: string): boolean {
  return !topLevelNodes(html).some((n) => hasText(n.innerHTML))
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

/** Escape user text so it can be re-inserted into the block's HTML safely. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Split a block's HTML into the editable slots the sidebar exposes.
 *   - `title` / `subtitle`: plain text of the leading H1 / H2 (per the format).
 *   - `body`: plain text of the remaining nodes, one line per node.
 *   - `bodyHtml`: the original rich body markup, preserved so editing the title
 *     or subtitle never flattens the body's formatting.
 */
export function getTextParts(html: string): { title: string; subtitle: string; body: string; bodyHtml: string } {
  const nodes = topLevelNodes(html)
  const slots = FORMAT_SLOTS[inferFormat(html)]
  let i = 0
  const title = slots.title ? (nodes[i++]?.textContent ?? '') : ''
  const subtitle = slots.subtitle ? (nodes[i++]?.textContent ?? '') : ''
  const bodyNodes = nodes.slice(i)
  const body = bodyNodes.map((n) => n.textContent ?? '').join('\n')
  const bodyHtml = bodyNodes.map((n) => n.outerHTML).join('') || '<p></p>'
  return { title, subtitle, body, bodyHtml }
}

/** Build the heading markup for a format from plain title/subtitle text. */
function headHtml(f: TextFormat, title: string, subtitle: string): string {
  const slots = FORMAT_SLOTS[f]
  let h = ''
  if (slots.title) h += `<h1>${escapeHtml(title)}</h1>`
  if (slots.subtitle) h += `<h2>${escapeHtml(subtitle)}</h2>`
  return h
}

/**
 * Write one slot back into the block's HTML, preserving the others. Editing the
 * title/subtitle keeps the rich body untouched; editing the body re-paragraphs
 * it (one <p> per line) — the canvas card remains the path for inline richness.
 */
export function setTextPart(html: string, part: 'title' | 'subtitle' | 'body', value: string): string {
  const f = inferFormat(html)
  const p = getTextParts(html)
  if (part === 'title') return headHtml(f, value, p.subtitle) + p.bodyHtml
  if (part === 'subtitle') return headHtml(f, p.title, value) + p.bodyHtml
  const bodyHtml = value.split('\n').map((l) => `<p>${escapeHtml(l)}</p>`).join('') || '<p></p>'
  return headHtml(f, p.title, p.subtitle) + bodyHtml
}

// ===========================================================================
// Video blocks
// ===========================================================================

export const VIDEO_BLOCK = 'video-block' as const

export type VideoStatus = 'empty' | 'not_analysed' | 'analysing' | 'analysed' | 'error'

/** Compactness level of a video block — user-toggled, persisted on the shape. */
export type VideoView = 'compact' | 'expanded' | 'full'

export interface Scene {
  idx?: number
  label?: string
  start_sec?: number
  end_sec?: number
  thumbnail?: string | null
  tags?: string[]
  description?: string
}

export interface VideoData {
  video_id?: string | null
  status?: VideoStatus
  source_url?: string | null
  title?: string | null
  duration_sec?: number | null
  thumbnail?: string | null
  palette?: string[]
  shot_count?: number
  analysis_error?: string | null
  transcript?: string | null
  description?: string | null
  tags?: string[]
  hook?: { text?: string; format?: string; strength?: number } | null
  storyboard?: Scene[]
}

export const DEFAULT_DATA: VideoData = { status: 'empty', title: '', tags: [], storyboard: [] }

export function parse(json: string): VideoData {
  if (!json) return DEFAULT_DATA
  try {
    const d = JSON.parse(json) as VideoData
    return { ...DEFAULT_DATA, ...d }
  } catch {
    return DEFAULT_DATA
  }
}

/** Target shape size per compactness level + status (clips overflow, so be generous). */
export function dims(view: VideoView, d: VideoData): { w: number; h: number } {
  const status = d.status ?? 'empty'
  if (view === 'compact') return { w: 360, h: 92 }
  if (view === 'full') {
    const n = Math.min(d.storyboard?.length ?? 0, 6)
    return { w: 384, h: 372 + n * 56 }
  }
  // expanded — height depends on what the stage discloses
  if (status === 'analysed') return { w: 360, h: 332 }
  if (status === 'analysing') return { w: 360, h: 168 }
  if (status === 'error') return { w: 360, h: 188 }
  if (status === 'not_analysed') return { w: 360, h: 156 }
  return { w: 360, h: 178 } // empty
}

export const STATUS_LABEL: Record<VideoStatus, string> = {
  empty: 'Ready for input',
  not_analysed: 'Not analysed',
  analysing: 'Analysing…',
  analysed: 'Analysed',
  error: 'Failed',
}

/** The detail levels offered in the sidebar inspector (compact → full). */
export const VIDEO_VIEW_OPTIONS: { id: VideoView; label: string }[] = [
  { id: 'compact', label: 'Compact' },
  { id: 'expanded', label: 'Expanded' },
  { id: 'full', label: 'Full detail' },
]

export const fmtTime = (sec?: number | null): string => {
  if (sec == null || !isFinite(sec)) return ''
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}
