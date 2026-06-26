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
  TLShapeId,
  resizeBox,
  useEditor,
  useValue,
} from 'tldraw'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import s from './VideoBlock.module.css'
import {
  VIDEO_BLOCK,
  VIDEO_VIEW_OPTIONS,
  DEFAULT_DATA,
  STATUS_LABEL,
  dims,
  fmtTime,
  parse,
  type Scene,
  type VideoData,
  type VideoStatus,
  type VideoView,
} from '@/lib/blockTypes'
import { analyseVideoShape, isBackendShape, pollVideo } from '@/lib/videoAnalysis'
import { relayoutFrame } from '@/lib/frameLayout'
import { DeleteButton, DragHandle } from './ShapeChrome'

// The video taxonomy (status lifecycle, detail levels, sizing, parsing) lives in
// lib/blockTypes so the adaptive sidebar can read + drive it from outside <Tldraw>.
type View = VideoView

/** Manual-resize floors. minHeight stays ≤ the compact card height so a user can
 * still drag an expanded card back near its compact footprint. */
const VB_MIN_W = 240
const VB_MIN_H = 80

/** Density preview per view level (reuses the text menu's stacked-bar previews) —
 * compact = header only, expanded = + summary, full = + transcript/storyboard. */
const VIEW_PREVIEW: Record<VideoView, ReactNode> = {
  compact: (
    <>
      <i className="t" />
    </>
  ),
  expanded: (
    <>
      <i className="t" />
      <i className="b" />
    </>
  ),
  full: (
    <>
      <i className="t" />
      <i className="b" />
      <i className="b2" />
    </>
  ),
}
const VIEW_OPTIONS = VIDEO_VIEW_OPTIONS.map((o) => ({ ...o, preview: VIEW_PREVIEW[o.id] }))

/**
 * Video Block — the fundamental interface for a video + its analysed data.
 *
 * Renders the analysis lifecycle (empty → not_analysed → analysing → analysed,
 * plus error) and progressively discloses fields as the analysis stage allows:
 *   *   title, thumbnail, tags
 *   **  transcript, description
 *   *** storyboard scenes
 * Three compactness levels — `compact`, `expanded`, `full` — are user-toggled
 * (chevron + storyboard toggle, or the sidebar inspector) and persisted on the
 * shape.
 *
 * The content lives in the `data` prop (JSON) so the canvas can drive it from a
 * Postgres-backed artifact (see lib/api.ts) or from a static seed XML.
 */
export { VIDEO_BLOCK } from '@/lib/blockTypes'

declare module 'tldraw' {
  export interface TLGlobalShapePropsMap {
    [VIDEO_BLOCK]: { w: number; h: number; view: string; data: string }
  }
}

export type VideoBlockShape = TLShape<typeof VIDEO_BLOCK>

export class VideoBlockShapeUtil extends ShapeUtil<VideoBlockShape> {
  static override type = VIDEO_BLOCK
  static override props: RecordProps<VideoBlockShape> = {
    w: T.number,
    h: T.number,
    view: T.string,
    data: T.string,
  }

  getDefaultProps(): VideoBlockShape['props'] {
    return { w: 360, h: 92, view: 'compact', data: JSON.stringify(DEFAULT_DATA) }
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

  getGeometry(shape: VideoBlockShape): Geometry2d {
    return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true })
  }

  override onResize(shape: VideoBlockShape, info: TLResizeInfo<VideoBlockShape>) {
    // Width-only: height is owned by the in-card auto-fit observer (so the
    // storyboard toggle is always reachable). Keep the original height + vertical
    // origin so a top-edge drag neither shifts the card nor fights the observer.
    const next = resizeBox(shape, info, { minWidth: VB_MIN_W, minHeight: VB_MIN_H })
    return { ...next, y: shape.y, props: { ...next.props, h: shape.props.h } }
  }

  component(shape: VideoBlockShape) {
    return <VideoBlock shape={shape} />
  }

  getIndicatorPath(shape: VideoBlockShape) {
    const path = new Path2D()
    const r = 18
    if (typeof path.roundRect === 'function') path.roundRect(0, 0, shape.props.w, shape.props.h, r)
    else path.rect(0, 0, shape.props.w, shape.props.h)
    return path
  }
}

// ── React render ───────────────────────────────────────────────────────────

function VideoBlock({ shape }: { shape: VideoBlockShape }) {
  const editor = useEditor()
  const view = (shape.props.view as View) || 'compact'
  const d = useValue('data', () => parse(shape.props.data), [shape.props.data])
  const status: VideoStatus = d.status ?? 'empty'

  // Chrome reveal: the delete/grip + the floating view menu all show together on
  // hover/selection, kept alive by their own hover with a short linger so the menu
  // above the card stays reachable across the gap (same pattern as the text card).
  const isHovered = useValue('hovered', () => editor.getHoveredShapeId() === shape.id, [editor, shape.id])
  const isSelected = useValue('selected', () => editor.getSelectedShapeIds().includes(shape.id), [editor, shape.id])
  const [chromeHover, setChromeHover] = useState(false) // grip / trash
  const [menuHover, setMenuHover] = useState(false) // the floating toolbar
  const [viewMenuOpen, setViewMenuOpen] = useState(false)
  const [showMain, setShowMain] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)

  const wantMain = isHovered || isSelected || chromeHover || menuHover || viewMenuOpen
  useEffect(() => {
    if (wantMain) {
      setShowMain(true)
      return
    }
    const t = window.setTimeout(() => setShowMain(false), 160)
    return () => window.clearTimeout(t)
  }, [wantMain])
  // Close the view menu whenever the chrome hides.
  useEffect(() => {
    if (!showMain) setViewMenuOpen(false)
  }, [showMain])

  // Auto-fit the card height to its content so a rich expanded card never clips the
  // storyboard toggle (the only way into 'full' view). The card is overflow:hidden
  // height:100%, so scrollHeight reports the full (clipped) content height; we grow
  // the shape to match. Height patches are derived (history-ignored, never synced),
  // mirroring the text card; setView still seeds the height, then this corrects it.
  useEffect(() => {
    const card = cardRef.current
    if (!card) return
    const fit = () => {
      if (card.offsetParent === null) return // culled offscreen → don't measure 0
      const cur = editor.getShape<VideoBlockShape>(shape.id)
      if (!cur) return
      const target = Math.ceil(card.scrollHeight)
      if (target < 1 || Math.abs(target - cur.props.h) <= 1) return
      editor.store.mergeRemoteChanges(() =>
        editor.run(() => editor.updateShape({ id: shape.id, type: VIDEO_BLOCK, props: { h: target } }), {
          history: 'ignore',
        }),
      )
      if (cur.parentId) relayoutFrame(editor, cur.parentId as TLShapeId)
    }
    const ro = new ResizeObserver(fit)
    ro.observe(card)
    fit()
    return () => ro.disconnect()
  }, [editor, shape.id])

  const setView = (next: View) => {
    const cur = editor.getShape<VideoBlockShape>(shape.id)
    if (!cur) return
    const pinned = (cur.meta as { pinned?: unknown }).pinned === true
    const size = dims(next, d)
    // `view` is a content edit (persists to the artifact). The size is view-DERIVED,
    // so apply it as a remote/history-ignored change — otherwise the w/h delta would
    // echo back through outbound sync as a manual resize and pin the block out of
    // auto-layout. A user-pinned width is respected; height is then auto-fit.
    editor.updateShape({ id: shape.id, type: VIDEO_BLOCK, props: { view: next } })
    editor.store.mergeRemoteChanges(() =>
      editor.run(
        () =>
          editor.updateShape({
            id: shape.id,
            type: VIDEO_BLOCK,
            props: { w: pinned ? cur.props.w : size.w, h: size.h },
          }),
        { history: 'ignore' },
      ),
    )
    // Re-flow the enclosing frame so changing the view never overlaps siblings.
    if (cur.parentId) relayoutFrame(editor, cur.parentId as TLShapeId)
  }

  // Trigger analysis from the in-block controls (URL entry / Analyse / Retry).
  // Backend-rendered elements re-run via the artifact's video_id; local blocks
  // trigger + poll themselves (see lib/videoAnalysis).
  const analyse = (url?: string) => void analyseVideoShape(editor, shape.id, url)

  // Resume/keep polling whenever a local block is mid-analysis (covers a reload
  // while analysing, or a trigger fired from the sidebar). Idempotent per shape.
  const backend = isBackendShape(String(shape.id))
  useEffect(() => {
    if (backend) return
    if (status !== 'analysing' || !d.video_id) return
    pollVideo(editor, shape.id, d.video_id)
  }, [backend, status, d.video_id, editor, shape.id])

  const stop = (e: React.PointerEvent) => e.stopPropagation()
  // Keep selection/hover when pressing a toolbar control (don't let it reach tldraw).
  const hold = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }
  const canStoryboard = status === 'analysed' && (d.storyboard?.length ?? 0) > 0
  const expanded = view !== 'compact'
  const currentView = VIEW_OPTIONS.find((o) => o.id === view) ?? VIEW_OPTIONS[1]

  return (
    <HTMLContainer>
      {/* host isolates the appear-animation aurora behind the card (see VideoBlock.module.css) */}
      <div className={s.host}>
        <div ref={cardRef} className={`${s.card} ${s[status]}`} onPointerDown={(e) => { if (expanded) e.stopPropagation() }}>
          <Header d={d} status={status} view={view} />

          {expanded && status === 'analysed' && <Body d={d} view={view} canStoryboard={canStoryboard} />}
          {expanded && status === 'analysing' && <Analysing d={d} />}
          {expanded && status === 'error' && <ErrorState d={d} onAnalyse={analyse} stop={stop} />}
          {expanded && status === 'not_analysed' && <NotAnalysed d={d} onAnalyse={analyse} stop={stop} />}
          {expanded && status === 'empty' && <Empty d={d} onAnalyse={analyse} stop={stop} />}
        </div>
      </div>

      <DeleteButton
        editor={editor}
        id={shape.id}
        show={showMain}
        onHoverChange={setChromeHover}
        className="vb-trash"
      />

      <DragHandle
        editor={editor}
        id={shape.id}
        show={showMain}
        onHoverChange={setChromeHover}
        className="vb-grip"
      />

      {/* Floating view picker — the video's equivalent of the text card's format
          menu: choose Compact / Expanded / Full instead of the in-block chevron. */}
      <div
        className={`vb-actions${showMain ? ' show' : ''}`}
        onPointerDown={(e) => e.stopPropagation()}
        onMouseEnter={() => setMenuHover(true)}
        onMouseLeave={() => setMenuHover(false)}
      >
        <div className={`rt-menu${viewMenuOpen ? ' show' : ''}`} role="menu">
          {VIEW_OPTIONS.map((o) => (
            <button
              key={o.id}
              role="menuitemradio"
              aria-checked={view === o.id}
              className={`rt-menu-item${view === o.id ? ' on' : ''}`}
              onMouseDown={hold}
              onClick={() => {
                setView(o.id)
                setViewMenuOpen(false)
              }}
              title={o.label}
            >
              <span className="rt-menu-preview">{o.preview}</span>
              <span className="rt-menu-label">{o.label}</span>
              {view === o.id && (
                <span className="rt-menu-check">
                  <CheckIcon />
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="rt-main">
          <button
            className={`rt-pill${viewMenuOpen ? ' on' : ''}`}
            onMouseDown={hold}
            onClick={() => setViewMenuOpen((o) => !o)}
            title="View detail"
          >
            {currentView.label} <span className="caret">⌄</span>
          </button>
          <button
            className="rt-icon"
            onMouseDown={hold}
            onClick={() => editor.duplicateShapes([shape.id], { x: 28, y: 28 })}
            title="Duplicate"
          >
            <CopyIcon />
          </button>
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

function Thumb({ d, wide }: { d: VideoData; wide?: boolean }) {
  const palette = d.palette?.length ? d.palette : ['#c7cdd9', '#aeb6c6']
  const grad = `linear-gradient(135deg, ${palette.slice(0, 4).join(', ')})`
  return (
    <div className={`${s.thumb} ${wide ? s.thumbWide : s.thumbCompact}`}>
      {d.thumbnail ? (
        // frame URLs may 404 (frames live on the worker host) → reveal the gradient under it
        <img src={d.thumbnail} alt="" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} />
      ) : null}
      <div className={s.thumbGrad} style={{ background: grad, position: d.thumbnail ? 'absolute' : 'static', inset: 0, zIndex: -1 }} />
      <div className={s.playGlyph}>
        <svg width={wide ? 26 : 20} height={wide ? 26 : 20} viewBox="0 0 24 24" fill="currentColor">
          <path d="M8 5v14l11-7z" />
        </svg>
      </div>
      {d.duration_sec ? <span className={s.thumbBadge}>{fmtTime(d.duration_sec)}</span> : null}
    </div>
  )
}

function Header({ d, status, view }: { d: VideoData; status: VideoStatus; view: View }) {
  const wide = view !== 'compact' && status !== 'empty'
  const title = d.title || (status === 'empty' ? 'Empty — ready for input' : 'Untitled video')
  return (
    <div className={s.header}>
      <Thumb d={d} wide={wide} />
      <div className={s.headMain}>
        <p className={`${s.title} ${status === 'empty' && !d.title ? s.titleEmpty : ''}`}>{title}</p>
        <div className={s.metaRow}>
          <span className={`${s.statusPill} ${s['s_' + status]}`}>
            <span className={s.dot} />
            {STATUS_LABEL[status]}
          </span>
          {status === 'analysed' && d.shot_count ? <span>{d.shot_count} shots</span> : null}
        </div>
      </div>
    </div>
  )
}

function Body({
  d,
  view,
  canStoryboard,
}: {
  d: VideoData
  view: View
  canStoryboard: boolean
}) {
  return (
    <div className={s.body}>
      <div className={s.divider} />
      {d.tags?.length ? (
        <div className={s.tags}>
          {d.tags.map((t, i) => (
            <span key={i} className={`${s.tag} ${i === 0 ? s.tagAccent : ''}`}>
              {t}
            </span>
          ))}
        </div>
      ) : null}

      {d.hook?.text ? <Hook hook={d.hook} /> : null}

      {d.description ? (
        <div>
          <div className={s.sectionLabel}>Summary</div>
          <p className={s.desc}>{d.description}</p>
        </div>
      ) : null}

      {view === 'full' && d.transcript ? (
        <div>
          <div className={s.sectionLabel}>Transcript</div>
          <div className={s.transcript}>{d.transcript}</div>
        </div>
      ) : null}

      {canStoryboard ? (
        <div>
          <div className={s.storyHead}>
            <div className={s.sectionLabel}>Storyboard · {d.storyboard!.length} scenes</div>
          </div>
          {view === 'full' ? <Storyboard scenes={d.storyboard!} /> : null}
        </div>
      ) : null}
    </div>
  )
}

function Hook({ hook }: { hook: NonNullable<VideoData['hook']> }) {
  const strength = Math.max(0, Math.min(10, hook.strength ?? 0))
  return (
    <div className={s.hook}>
      <div className={s.hookHead}>
        <div className={s.sectionLabel}>Hook{hook.format ? ` · ${hook.format.replace(/_/g, ' ')}` : ''}</div>
        {hook.strength ? (
          <div className={s.strengthBar} title={`Hook strength ${hook.strength}/10`}>
            {Array.from({ length: 10 }, (_, i) => (
              <i key={i} className={i < strength ? s.on : ''} />
            ))}
          </div>
        ) : null}
      </div>
      <div className={s.hookText}>“{hook.text}”</div>
    </div>
  )
}

function Storyboard({ scenes }: { scenes: Scene[] }) {
  return (
    <div className={s.scenes}>
      {scenes.slice(0, 6).map((sc, i) => (
        <div key={i} className={s.scene}>
          <div className={s.sceneThumb}>
            {sc.thumbnail ? <img src={sc.thumbnail} alt="" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} /> : null}
            <span className={s.sceneNum}>{i + 1}</span>
          </div>
          <div className={s.sceneMain}>
            <p className={s.sceneLabel}>{sc.label || `Scene ${i + 1}`}</p>
            <div className={s.sceneTags}>
              {(sc.tags ?? []).map((t, j) => (
                <span key={j} className={s.sceneTag}>{t}</span>
              ))}
            </div>
          </div>
          <span className={s.sceneTime}>{fmtTime(sc.start_sec)}</span>
        </div>
      ))}
      {scenes.length > 6 ? <span className={s.sceneTime}>+{scenes.length - 6} more scenes</span> : null}
    </div>
  )
}

function Analysing({ d }: { d: VideoData }) {
  return (
    <div className={s.progress}>
      <div className={s.progressBar}>
        <div className={s.progressFill} />
      </div>
      <span className={s.progressNote}>
        Analysing video — downloading, detecting shots, transcribing & reading frames…
      </span>
    </div>
  )
}

type StateProps = {
  d: VideoData
  onAnalyse: (url?: string) => void
  stop: (e: React.PointerEvent) => void
}

/** URL field + Analyse button — the in-block way to add a source and kick off
 * analysis (the empty + not-analysed states share it). Enter submits. The
 * `https://…` placeholder is self-explanatory, so there's no hint line above it. */
function UrlEntry({ d, onAnalyse, stop, cta }: StateProps & { cta: string }) {
  const [url, setUrl] = useState(d.source_url || '')
  const trimmed = url.trim()
  const submit = () => {
    if (trimmed) onAnalyse(trimmed)
  }
  return (
    <div className={s.empties}>
      <div className={s.urlRow}>
        <input
          className={s.urlInput}
          placeholder="https://…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onPointerDown={stop}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') submit()
          }}
        />
        <button className={s.btn} onPointerDown={stop} onClick={submit} disabled={!trimmed}>
          {cta}
        </button>
      </div>
    </div>
  )
}

function ErrorState({ d, onAnalyse, stop }: StateProps) {
  return (
    <div className={s.empties}>
      <div className={s.errBox}>{d.analysis_error || 'Analysis failed. The source may be unavailable.'}</div>
      <button
        className={`${s.btn} ${s.btnGhost}`}
        onPointerDown={stop}
        onClick={() => onAnalyse()}
      >
        Retry analysis
      </button>
    </div>
  )
}

function NotAnalysed({ d, onAnalyse, stop }: StateProps) {
  // If a source URL is already on the block, offer a one-tap analyse; otherwise
  // fall back to URL entry so a not-analysed block is never a dead end.
  if (d.source_url) {
    return (
      <div className={s.empties}>
        <span className={s.emptyHint}>
          This video hasn’t been analysed yet — unlock tags, transcript and the storyboard.
        </span>
        <button className={s.btn} onPointerDown={stop} onClick={() => onAnalyse()}>
          Analyse video
        </button>
      </div>
    )
  }
  return <UrlEntry d={d} onAnalyse={onAnalyse} stop={stop} cta="Analyse video" />
}

function Empty({ d, onAnalyse, stop }: StateProps) {
  return <UrlEntry d={d} onAnalyse={onAnalyse} stop={stop} cta="Analyse" />
}
