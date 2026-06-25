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
import s from './VideoBlock.module.css'

/**
 * Video Block — the fundamental interface for a video + its analysed data.
 *
 * Renders the analysis lifecycle (empty → not_analysed → analysing → analysed,
 * plus error) and progressively discloses fields as the analysis stage allows:
 *   *   title, thumbnail, tags
 *   **  transcript, description
 *   *** storyboard scenes
 * Three compactness levels — `compact`, `expanded`, `full` — are user-toggled
 * (chevron + storyboard toggle) and persisted on the shape.
 *
 * The content lives in the `data` prop (JSON) so the canvas can drive it from a
 * Postgres-backed artifact (see lib/api.ts) or from a static seed XML.
 */
export const VIDEO_BLOCK = 'video-block' as const

declare module 'tldraw' {
  export interface TLGlobalShapePropsMap {
    [VIDEO_BLOCK]: { w: number; h: number; view: string; data: string }
  }
}

export type VideoBlockShape = TLShape<typeof VIDEO_BLOCK>

export type VideoStatus = 'empty' | 'not_analysed' | 'analysing' | 'analysed' | 'error'

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

type View = 'compact' | 'expanded' | 'full'

const DEFAULT_DATA: VideoData = { status: 'empty', title: '', tags: [], storyboard: [] }

function parse(json: string): VideoData {
  if (!json) return DEFAULT_DATA
  try {
    const d = JSON.parse(json) as VideoData
    return { ...DEFAULT_DATA, ...d }
  } catch {
    return DEFAULT_DATA
  }
}

/** Target shape size per compactness level + status (clips overflow, so be generous). */
export function dims(view: View, d: VideoData): { w: number; h: number } {
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

const STATUS_LABEL: Record<VideoStatus, string> = {
  empty: 'Ready for input',
  not_analysed: 'Not analysed',
  analysing: 'Analysing…',
  analysed: 'Analysed',
  error: 'Failed',
}

const fmtTime = (sec?: number | null) => {
  if (sec == null || !isFinite(sec)) return ''
  const m = Math.floor(sec / 60)
  const s2 = Math.round(sec % 60)
  return `${m}:${s2.toString().padStart(2, '0')}`
}

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

  const setView = (next: View) => {
    const size = dims(next, d)
    editor.updateShape({ id: shape.id, type: VIDEO_BLOCK, props: { view: next, ...size } })
  }

  const stop = (e: React.PointerEvent) => e.stopPropagation()
  const canStoryboard = status === 'analysed' && (d.storyboard?.length ?? 0) > 0
  const expanded = view !== 'compact'

  return (
    <HTMLContainer>
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
        {expanded && status === 'error' && <ErrorState d={d} />}
        {expanded && status === 'not_analysed' && <NotAnalysed stop={stop} />}
        {expanded && status === 'empty' && <Empty d={d} stop={stop} />}
      </div>
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

function ErrorState({ d }: { d: VideoData }) {
  return (
    <div className={s.empties}>
      <div className={s.errBox}>{d.analysis_error || 'Analysis failed. The source may be unavailable.'}</div>
      <button className={`${s.btn} ${s.btnGhost}`} onPointerDown={(e) => e.stopPropagation()}>Retry analysis</button>
    </div>
  )
}

function NotAnalysed({ stop }: { stop: (e: React.PointerEvent) => void }) {
  return (
    <div className={s.empties}>
      <span className={s.emptyHint}>This video hasn’t been analysed yet. Ask Rainy to analyse it to unlock tags, transcript and the storyboard.</span>
      <button className={s.btn} onPointerDown={stop}>Analyse video</button>
    </div>
  )
}

function Empty({ d, stop }: { d: VideoData; stop: (e: React.PointerEvent) => void }) {
  return (
    <div className={s.empties}>
      <span className={s.emptyHint}>Paste a video URL, or ask Rainy to add one to this project.</span>
      <div className={s.urlRow}>
        <input
          className={s.urlInput}
          placeholder="https://…"
          defaultValue={d.source_url || ''}
          onPointerDown={stop}
          onKeyDown={(e) => e.stopPropagation()}
        />
        <button className={s.btn} onPointerDown={stop}>Add</button>
      </div>
    </div>
  )
}
