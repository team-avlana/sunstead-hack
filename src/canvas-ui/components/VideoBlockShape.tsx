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
import { useEffect, useState } from 'react'
import s from './VideoBlock.module.css'
import {
  VIDEO_BLOCK,
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
import { DeleteButton } from './ShapeChrome'

// The video taxonomy (status lifecycle, detail levels, sizing, parsing) lives in
// lib/blockTypes so the adaptive sidebar can read + drive it from outside <Tldraw>.
type View = VideoView

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
    return resizeBox(shape, info)
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

  // Hover/selection drives the delete affordance. The button straddles the
  // corner (outside geometry), so we OR in its own hover to keep it alive.
  const isHovered = useValue('hovered', () => editor.getHoveredShapeId() === shape.id, [editor, shape.id])
  const isSelected = useValue('selected', () => editor.getSelectedShapeIds().includes(shape.id), [editor, shape.id])
  const [trashHover, setTrashHover] = useState(false)

  const setView = (next: View) => {
    const size = dims(next, d)
    editor.updateShape({ id: shape.id, type: VIDEO_BLOCK, props: { view: next, ...size } })
    // Re-flow the enclosing frame so expanding/collapsing never overlaps siblings.
    const parent = editor.getShape(shape.id)?.parentId
    if (parent) relayoutFrame(editor, parent as TLShapeId)
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
  const canStoryboard = status === 'analysed' && (d.storyboard?.length ?? 0) > 0
  const expanded = view !== 'compact'

  return (
    <HTMLContainer>
      {/* host isolates the appear-animation aurora behind the card (see VideoBlock.module.css) */}
      <div className={s.host}>
        <div className={`${s.card} ${s[status]}`} onPointerDown={(e) => { if (expanded) e.stopPropagation() }}>
          <Header
            d={d}
            status={status}
            view={view}
            onToggle={() => setView(view === 'compact' ? 'expanded' : 'compact')}
            stop={stop}
          />

          {expanded && status === 'analysed' && (
            <Body d={d} view={view} canStoryboard={canStoryboard} setView={setView} stop={stop} />
          )}
          {expanded && status === 'analysing' && <Analysing d={d} />}
          {expanded && status === 'error' && <ErrorState d={d} onAnalyse={analyse} stop={stop} />}
          {expanded && status === 'not_analysed' && <NotAnalysed d={d} onAnalyse={analyse} stop={stop} />}
          {expanded && status === 'empty' && <Empty d={d} onAnalyse={analyse} stop={stop} />}
        </div>
      </div>

      <DeleteButton
        editor={editor}
        id={shape.id}
        show={isHovered || isSelected || trashHover}
        onHoverChange={setTrashHover}
        className="vb-trash"
      />
    </HTMLContainer>
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

function Header({
  d,
  status,
  view,
  onToggle,
  stop,
}: {
  d: VideoData
  status: VideoStatus
  view: View
  onToggle: () => void
  stop: (e: React.PointerEvent) => void
}) {
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
      <button
        className={`${s.chev} ${view !== 'compact' ? s.chevUp : ''}`}
        onPointerDown={stop}
        onClick={onToggle}
        title={view === 'compact' ? 'Expand' : 'Collapse'}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
    </div>
  )
}

function Body({
  d,
  view,
  canStoryboard,
  setView,
  stop,
}: {
  d: VideoData
  view: View
  canStoryboard: boolean
  setView: (v: View) => void
  stop: (e: React.PointerEvent) => void
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
            <button
              className={s.storyToggle}
              onPointerDown={stop}
              onClick={() => setView(view === 'full' ? 'expanded' : 'full')}
            >
              {view === 'full' ? 'Hide' : 'Show'}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ transform: view === 'full' ? 'rotate(180deg)' : 'none' }}>
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
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
 * analysis (the empty + not-analysed states share it). Enter submits. */
function UrlEntry({ d, onAnalyse, stop, hint, cta }: StateProps & { hint: string; cta: string }) {
  const [url, setUrl] = useState(d.source_url || '')
  const trimmed = url.trim()
  const submit = () => {
    if (trimmed) onAnalyse(trimmed)
  }
  return (
    <div className={s.empties}>
      <span className={s.emptyHint}>{hint}</span>
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
  return (
    <UrlEntry
      d={d}
      onAnalyse={onAnalyse}
      stop={stop}
      hint="Add a video URL to analyse, or ask Rainy to add one to this project."
      cta="Analyse video"
    />
  )
}

function Empty({ d, onAnalyse, stop }: StateProps) {
  return (
    <UrlEntry
      d={d}
      onAnalyse={onAnalyse}
      stop={stop}
      hint="Paste a video URL, or ask Rainy to add one to this project."
      cta="Analyse"
    />
  )
}
