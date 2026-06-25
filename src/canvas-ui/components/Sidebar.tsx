'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { gsap } from 'gsap'
import type { Editor, TLShape, TLShapeId } from 'tldraw'
import { useIsoLayoutEffect } from '@/lib/useIso'
import { useRainyStore } from '@/lib/store'
import {
  RAINY_TEXT,
  VIDEO_BLOCK,
  TEXT_FORMAT_OPTIONS,
  VIDEO_VIEW_OPTIONS,
  STATUS_LABEL,
  type TextFormat,
  type VideoView,
  type VideoStatus,
  inferFormat,
  restructure,
  setDefaultTextFormat,
  textIsEmpty,
  parse,
  dims,
} from '@/lib/blockTypes'

/** The live tldraw editor, published on the window by CanvasWorkspace.onMount. */
const ed = (): Editor | undefined =>
  typeof window !== 'undefined' ? (window as any).__rainyEditor : undefined

// ===========================================================================
// Selection model — a tiny normalized snapshot of what's selected, so the
// inspector renders from plain data and never reaches into the editor to draw.
// ===========================================================================

type TextSel = { id: TLShapeId; kind: 'text'; format: TextFormat; empty: boolean }
type VideoSel = {
  id: TLShapeId
  kind: 'video'
  view: VideoView
  status: VideoStatus
  scenes: number
}
type OtherSel = { id: TLShapeId; kind: 'other'; shapeType: string }
type Sel = TextSel | VideoSel | OtherSel

function normalize(shape: TLShape): Sel {
  if (shape.type === RAINY_TEXT) {
    const html = String((shape.props as any).html ?? '')
    return { id: shape.id, kind: 'text', format: inferFormat(html), empty: textIsEmpty(html) }
  }
  if (shape.type === VIDEO_BLOCK) {
    const d = parse(String((shape.props as any).data ?? ''))
    return {
      id: shape.id,
      kind: 'video',
      view: (String((shape.props as any).view || 'compact') as VideoView),
      status: d.status ?? 'empty',
      scenes: d.storyboard?.length ?? 0,
    }
  }
  return { id: shape.id, kind: 'other', shapeType: shape.type }
}

/**
 * Reactively snapshot the current selection.
 *
 * Selection identity arrives via the store's `selectedIds` (kept fresh by the
 * editor in CanvasWorkspace). Prop edits to an already-selected block (format,
 * detail level, analysis status) are document-scoped store changes, so we also
 * listen on the editor store and recompute. Re-keyed on the project so a project
 * switch (which remounts the editor) re-acquires the new instance.
 */
function useSelection(): Sel[] {
  const projectId = useRainyStore((s) => s.currentProjectId)
  const selectedIds = useRainyStore((s) => s.selectedIds)
  const [sel, setSel] = useState<Sel[]>([])
  const lastKey = useRef('')

  useEffect(() => {
    let cancelled = false
    let raf = 0
    let unlisten: (() => void) | undefined

    const recompute = () => {
      const e = ed()
      if (!e || e.isDisposed) return
      const next = e
        .getSelectedShapeIds()
        .map((id) => e.getShape(id))
        .filter((s): s is TLShape => !!s)
        .map(normalize)
      const key = JSON.stringify(next)
      if (key !== lastKey.current) {
        lastKey.current = key
        setSel(next)
      }
    }

    const attach = () => {
      if (cancelled) return
      const e = ed()
      if (!e || e.isDisposed) {
        raf = requestAnimationFrame(attach)
        return
      }
      recompute()
      unlisten = e.store.listen(recompute, { scope: 'document' })
    }
    attach()

    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      unlisten?.()
    }
  }, [projectId, selectedIds])

  return sel
}

// ===========================================================================
// Operations — drive the same shape transforms the in-canvas chrome uses, but
// from outside the editor (we hold the editor via the window handle).
// ===========================================================================

function withEditor(fn: (e: Editor) => void) {
  const e = ed()
  if (e && !e.isDisposed) fn(e)
}

/** Restructure one or more text blocks into `next` (the variant they convert to). */
function applyTextFormat(ids: TLShapeId[], next: TextFormat) {
  withEditor((e) => {
    setDefaultTextFormat(next)
    e.run(() => {
      for (const id of ids) {
        const shape = e.getShape(id)
        if (!shape || shape.type !== RAINY_TEXT) continue
        const cur = String((shape.props as any).html ?? '')
        const html = restructure(cur, next)
        if (html === cur) continue
        // Leave edit mode first so the card re-syncs its content from the prop.
        if (e.getEditingShapeId() === id) e.setEditingShape(null)
        e.updateShape({ id, type: RAINY_TEXT, props: { html } })
      }
    })
  })
}

/** Switch one or more video blocks to detail level `next` (and resize to fit). */
function applyVideoView(ids: TLShapeId[], next: VideoView) {
  withEditor((e) => {
    e.run(() => {
      for (const id of ids) {
        const shape = e.getShape(id)
        if (!shape || shape.type !== VIDEO_BLOCK) continue
        const d = parse(String((shape.props as any).data ?? ''))
        e.updateShape({ id, type: VIDEO_BLOCK, props: { view: next, ...dims(next, d) } })
      }
    })
  })
}

function editText(id: TLShapeId) {
  withEditor((e) =>
    e.run(() => {
      e.select(id)
      e.setEditingShape(id)
      e.setCurrentTool('select.editing_shape')
    }),
  )
}

const duplicate = (ids: TLShapeId[]) => withEditor((e) => e.duplicateShapes(ids, { x: 28, y: 28 }))
const remove = (ids: TLShapeId[]) => withEditor((e) => e.deleteShapes(ids))

// ===========================================================================
// Sidebar shell — header + collapse/intro animation + adaptive body.
// ===========================================================================

export default function Sidebar() {
  const ref = useRef<HTMLElement>(null)
  const collapsed = useRainyStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useRainyStore((s) => s.toggleSidebar)
  const sel = useSelection()

  // Intro animation (runs once). Scoped in a gsap.context so it reverts cleanly
  // and never clobbers the collapse tween below.
  useIsoLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ctx = gsap.context(() => {
      gsap.from(el, { x: -16, autoAlpha: 0, duration: 0.5, ease: 'power3.out' })
    })
    return () => ctx.revert()
  }, [])

  // Collapse / expand. GSAP must own this: the intro leaves an inline transform
  // on the <aside>, and an inline transform beats any stylesheet rule — so a
  // CSS-class approach silently does nothing. Animating the same inline
  // transform here is what actually slides the panel, smoothly both ways.
  const firstRun = useRef(true)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (firstRun.current) {
      firstRun.current = false
      return
    }
    const hideX = -(el.offsetWidth + 28) // width + left inset + shadow, fully off-screen
    gsap.to(el, {
      x: collapsed ? hideX : 0,
      autoAlpha: collapsed ? 0 : 1,
      duration: 0.42,
      ease: collapsed ? 'power3.in' : 'power3.out',
      overwrite: 'auto',
    })
  }, [collapsed])

  // Re-key the body on selection identity so it cross-fades when you pick a
  // different block, but updates in place when you toggle the selected block's
  // own variant (those keep the same ids).
  const bodyKey = sel.length ? sel.map((s) => s.id).join(',') : 'empty'

  return (
    <>
      <aside className="rainy-sidebar" ref={ref}>
        <div className="ci">
          <div className="ci-head">
            <div className="ci-title">{panelTitle(sel)}</div>
            <button
              type="button"
              className="ci-collapse"
              title="Hide sidebar"
              aria-label="Hide sidebar"
              onClick={toggleSidebar}
            >
              <SidebarIcon size={18} />
            </button>
          </div>

          <div className="insp" key={bodyKey}>
            <Inspector sel={sel} />
          </div>
        </div>
      </aside>

      <button
        type="button"
        className={`rainy-sidebar-show${collapsed ? ' show' : ''}`}
        title="Show sidebar"
        aria-label="Show sidebar"
        onClick={toggleSidebar}
      >
        <SidebarIcon size={19} />
      </button>
    </>
  )
}

function panelTitle(sel: Sel[]): string {
  if (sel.length === 0) return 'Canvas'
  if (sel.length > 1) return `${sel.length} selected`
  const s = sel[0]
  return s.kind === 'text' ? 'Text block' : s.kind === 'video' ? 'Video block' : 'Block'
}

// ===========================================================================
// Inspector — routes the selection to the right adaptive panel.
// ===========================================================================

function Inspector({ sel }: { sel: Sel[] }) {
  if (sel.length === 0) return <EmptyState />

  const kinds = new Set(sel.map((s) => s.kind))
  if (kinds.size === 1) {
    const kind = sel[0].kind
    if (kind === 'text') return <TextInspector sels={sel as TextSel[]} />
    if (kind === 'video') return <VideoInspector sels={sel as VideoSel[]} />
    return <OtherInspector sels={sel as OtherSel[]} />
  }
  return <MixedInspector sel={sel} />
}

function EmptyState() {
  return (
    <div className="insp-empty">
      <span className="insp-empty-icon">
        <CursorIcon />
      </span>
      <p className="insp-empty-title">Nothing selected</p>
      <p className="insp-empty-text">
        Select a text or video block to switch its layout and see the suggested next steps.
      </p>
    </div>
  )
}

// ---- Text -----------------------------------------------------------------

function TextInspector({ sels }: { sels: TextSel[] }) {
  const ids = sels.map((s) => s.id)
  const multi = sels.length > 1
  const current = allSame(sels.map((s) => s.format)) ? sels[0].format : null
  const allEmpty = sels.every((s) => s.empty)

  return (
    <>
      <Section label="Layout">
        <Variants
          options={TEXT_FORMAT_OPTIONS.map((o) => ({
            id: o.id,
            label: o.label,
            preview: <TextPreview f={o.id} />,
          }))}
          current={current}
          onPick={(id) => applyTextFormat(ids, id as TextFormat)}
        />
      </Section>

      <Section label={multi ? 'Actions' : 'Next steps'}>
        {!multi && (
          <button className="insp-btn primary" onClick={() => editText(ids[0])}>
            {allEmpty ? 'Start writing' : 'Edit text'}
          </button>
        )}
        <button className="insp-btn" onClick={() => duplicate(ids)}>
          Duplicate{multi ? ` (${ids.length})` : ''}
        </button>
        <button className="insp-btn danger" onClick={() => remove(ids)}>
          Delete{multi ? ` (${ids.length})` : ''}
        </button>
      </Section>

      <p className="insp-hint">
        {multi
          ? 'Pick a layout to apply it to every selected text block — your text is kept.'
          : 'Switch the layout above, or edit the card directly on the canvas.'}
      </p>
    </>
  )
}

function TextPreview({ f }: { f: TextFormat }) {
  if (f === 'plain')
    return (
      <>
        <i className="ln b" />
        <i className="ln b" />
      </>
    )
  if (f === 'title')
    return (
      <>
        <i className="ln t" />
        <i className="ln b" />
        <i className="ln b" />
      </>
    )
  return (
    <>
      <i className="ln t" />
      <i className="ln s" />
      <i className="ln b" />
    </>
  )
}

// ---- Video ----------------------------------------------------------------

function VideoInspector({ sels }: { sels: VideoSel[] }) {
  const ids = sels.map((s) => s.id)
  const multi = sels.length > 1
  const current = allSame(sels.map((s) => s.view)) ? sels[0].view : null
  // "Full" only adds analysed-only detail (transcript / storyboard).
  const analysed = sels.every((s) => s.status === 'analysed')
  const single = multi ? null : sels[0]

  return (
    <>
      <Section label="Detail">
        <Variants
          options={VIDEO_VIEW_OPTIONS.map((o) => ({
            id: o.id,
            label: o.label,
            preview: <VideoPreview v={o.id} />,
            disabled: o.id === 'full' && !analysed,
            hint: o.id === 'full' && !analysed ? 'Needs analysis' : undefined,
          }))}
          current={current}
          onPick={(id) => applyVideoView(ids, id as VideoView)}
        />
      </Section>

      {single && (
        <Section label="Status">
          <div className={`insp-status s_${single.status}`}>
            <span className="insp-status-dot" />
            <span>{STATUS_LABEL[single.status]}</span>
            {single.status === 'analysed' && single.scenes > 0 && (
              <span className="insp-status-meta">{single.scenes} scenes</span>
            )}
          </div>
        </Section>
      )}

      <Section label={multi ? 'Actions' : 'Next steps'}>
        {single && single.status === 'analysed' && single.scenes > 0 && (
          <button
            className="insp-btn primary"
            onClick={() => applyVideoView(ids, single.view === 'full' ? 'expanded' : 'full')}
          >
            {single.view === 'full' ? 'Hide storyboard' : 'Show full storyboard'}
          </button>
        )}
        <button className="insp-btn" onClick={() => duplicate(ids)}>
          Duplicate{multi ? ` (${ids.length})` : ''}
        </button>
        <button className="insp-btn danger" onClick={() => remove(ids)}>
          Delete{multi ? ` (${ids.length})` : ''}
        </button>
      </Section>

      <p className="insp-hint">{single ? videoHint(single.status) : 'Pick a detail level for every selected video.'}</p>
    </>
  )
}

function videoHint(status: VideoStatus): string {
  switch (status) {
    case 'empty':
      return 'Add a video URL on the card, or ask Rainey to add one to this project.'
    case 'not_analysed':
      return 'Ask Rainey to analyse this video to unlock its tags, transcript and storyboard.'
    case 'analysing':
      return 'Analysis is running — tags, transcript and the storyboard appear when it finishes.'
    case 'analysed':
      return 'Switch the detail above to reveal the summary, transcript and storyboard.'
    case 'error':
      return 'Analysis failed. Ask Rainey to retry, or check the source URL on the card.'
  }
}

function VideoPreview({ v }: { v: VideoView }) {
  if (v === 'compact') return <i className="bk sm" />
  if (v === 'expanded')
    return (
      <>
        <i className="bk" />
        <i className="ln b" />
      </>
    )
  return (
    <>
      <i className="bk" />
      <i className="ln b" />
      <i className="ln b" />
    </>
  )
}

// ---- Other / mixed --------------------------------------------------------

function OtherInspector({ sels }: { sels: OtherSel[] }) {
  const ids = sels.map((s) => s.id)
  const name = sels.length > 1 ? `${sels.length} blocks` : shapeLabel(sels[0].shapeType)
  return (
    <>
      <Section label="Block">
        <div className="insp-summary">{name}</div>
      </Section>
      <Section label="Actions">
        <button className="insp-btn" onClick={() => duplicate(ids)}>
          Duplicate{sels.length > 1 ? ` (${ids.length})` : ''}
        </button>
        <button className="insp-btn danger" onClick={() => remove(ids)}>
          Delete{sels.length > 1 ? ` (${ids.length})` : ''}
        </button>
      </Section>
    </>
  )
}

function MixedInspector({ sel }: { sel: Sel[] }) {
  const ids = sel.map((s) => s.id)
  return (
    <>
      <Section label="Selection">
        <div className="insp-summary">{summarize(sel)}</div>
      </Section>
      <Section label="Actions">
        <button className="insp-btn" onClick={() => duplicate(ids)}>
          Duplicate ({ids.length})
        </button>
        <button className="insp-btn danger" onClick={() => remove(ids)}>
          Delete ({ids.length})
        </button>
      </Section>
      <p className="insp-hint">Select blocks of one type to switch their layout together.</p>
    </>
  )
}

// ===========================================================================
// Shared bits
// ===========================================================================

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="insp-section">
      <div className="insp-label">{label}</div>
      {children}
    </div>
  )
}

type VariantOpt = { id: string; label: string; preview: ReactNode; disabled?: boolean; hint?: string }

/** The variant switcher: the heart of the adaptive sidebar. */
function Variants({
  options,
  current,
  onPick,
}: {
  options: VariantOpt[]
  current: string | null
  onPick: (id: string) => void
}) {
  return (
    <div className="insp-variants" role="radiogroup">
      {options.map((o) => {
        const on = current === o.id
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={on}
            className={`insp-variant${on ? ' on' : ''}`}
            disabled={o.disabled}
            title={o.hint || o.label}
            onClick={() => !o.disabled && onPick(o.id)}
          >
            <span className="insp-pv">{o.preview}</span>
            <span className="insp-variant-label">{o.label}</span>
            {on ? (
              <span className="insp-check">
                <CheckIcon />
              </span>
            ) : o.disabled && o.hint ? (
              <span className="insp-variant-hint">{o.hint}</span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}

// ---- helpers --------------------------------------------------------------

function allSame<T>(xs: T[]): boolean {
  return xs.every((x) => x === xs[0])
}

function shapeLabel(type: string): string {
  if (type === 'frame') return 'Frame'
  return type.replace(/[-_]/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}

function summarize(sel: Sel[]): string {
  const n = (k: Sel['kind']) => sel.filter((s) => s.kind === k).length
  const parts: string[] = []
  if (n('text')) parts.push(`${n('text')} text`)
  if (n('video')) parts.push(`${n('video')} video`)
  const other = n('other')
  if (other) parts.push(`${other} other`)
  return parts.join(' · ')
}

// ---- icons ----------------------------------------------------------------

/**
 * SF Symbols–style `sidebar.left` glyph: a rounded rectangle with a leading
 * divider marking off the sidebar column. Used as the single toggle icon for
 * both hide (in-panel) and show (floating) controls, matching macOS.
 */
function SidebarIcon({ size = 19 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="14" rx="2.8" />
      <path d="M9 5v14" />
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

function CursorIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 3l6 16 2.5-6.5L20 10z" />
    </svg>
  )
}
