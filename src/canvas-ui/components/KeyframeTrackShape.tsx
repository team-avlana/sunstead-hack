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
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import s from './KeyframeTrack.module.css'
import {
  KEYFRAME_TRACK,
  KEYFRAME_VIEW_OPTIONS,
  fmtTime,
  parseKeyframeData,
  type Keyframe,
  type KeyframeTrackData,
  type KeyframeView,
} from '@/lib/blockTypes'
import { fetchCreators, fetchCreatorVideos, fetchVideoShots, resolveAssetUrl } from '@/lib/api'
import { DeleteButton, DragHandle } from './ShapeChrome'
import { VideoPeek } from './VideoPeek'

/**
 * Keyframe Track — a scrubbable filmstrip of the keyframes (one representative
 * still per clip/cut) behind a video.
 *
 * Two sources of keyframes, mirrored in the artifact payload (see backendCanvas):
 *   1. an explicit `keyframes` array — what an agent writes after pulling clip
 *      data from the avlana MCP, each with a direct image URL. Rendered as-is.
 *   2. a `video_id` — the track self-populates from that analysed video's shots
 *      (`/api/videos/{id}/shots`, one keyframe per cut).
 * Either way each tile carries its clip index + timecode; clicking one opens a
 * centred peek (and, when a source is playable / mapped, plays from that cut).
 *
 * The whole track lives in the shape's `data` JSON so a Postgres-backed artifact
 * drives it (and persists user edits) exactly like the Video Block. Keyframes
 * fetched from a video_id are render-only state — they never write back to `data`,
 * so a reload re-derives them and the persisted payload stays tiny.
 */
export { KEYFRAME_TRACK } from '@/lib/blockTypes'

declare module 'tldraw' {
  export interface TLGlobalShapePropsMap {
    [KEYFRAME_TRACK]: { w: number; h: number; data: string }
  }
}

export type KeyframeTrackShape = TLShape<typeof KEYFRAME_TRACK>

const KT_MIN_W = 320
const KT_MIN_H = 150

export class KeyframeTrackShapeUtil extends ShapeUtil<KeyframeTrackShape> {
  static override type = KEYFRAME_TRACK
  static override props: RecordProps<KeyframeTrackShape> = {
    w: T.number,
    h: T.number,
    data: T.string,
  }

  getDefaultProps(): KeyframeTrackShape['props'] {
    return { w: 600, h: 226, data: JSON.stringify({ title: '', view: 'strip', keyframes: [] }) }
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

  getGeometry(shape: KeyframeTrackShape): Geometry2d {
    return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true })
  }

  override onResize(shape: KeyframeTrackShape, info: TLResizeInfo<KeyframeTrackShape>) {
    return resizeBox(shape, info, { minWidth: KT_MIN_W, minHeight: KT_MIN_H })
  }

  component(shape: KeyframeTrackShape) {
    return <KeyframeTrack shape={shape} />
  }

  getIndicatorPath(shape: KeyframeTrackShape) {
    const path = new Path2D()
    const r = 18
    if (typeof path.roundRect === 'function') path.roundRect(0, 0, shape.props.w, shape.props.h, r)
    else path.rect(0, 0, shape.props.w, shape.props.h)
    return path
  }
}

// ── React render ───────────────────────────────────────────────────────────

type Loaded = { state: 'idle' | 'loading' | 'ready' | 'error'; keyframes: Keyframe[] }

function KeyframeTrack({ shape }: { shape: KeyframeTrackShape }) {
  const editor = useEditor()
  const d = useValue('data', () => parseKeyframeData(shape.props.data), [shape.props.data])
  const view: KeyframeView = d.view === 'grid' ? 'grid' : 'strip'

  // Explicit keyframes (avlana path) win; otherwise self-populate from video_id.
  const explicit = (d.keyframes ?? []).filter((k) => k && (k.src || k.idx != null))
  const [fetched, setFetched] = useState<Loaded>({ state: 'idle', keyframes: [] })

  useEffect(() => {
    if (explicit.length || !d.video_id) {
      setFetched({ state: 'idle', keyframes: [] })
      return
    }
    let cancelled = false
    setFetched({ state: 'loading', keyframes: [] })
    void fetchVideoShots(d.video_id).then((res) => {
      if (cancelled) return
      if (!res) {
        setFetched({ state: 'error', keyframes: [] })
        return
      }
      const kfs: Keyframe[] = res.shots.map((sh) => {
        const llm = (sh.analysis?.llm ?? {}) as Record<string, unknown>
        return {
          src: sh.frame_url ?? (sh.frame_id ? `/frames/${sh.frame_id}` : null),
          idx: sh.idx,
          start_sec: sh.start_sec,
          end_sec: sh.end_sec,
          shot_type: typeof llm.shot_type === 'string' ? llm.shot_type : null,
          label: typeof llm.subject === 'string' ? llm.subject : null,
        }
      })
      setFetched({ state: 'ready', keyframes: kfs })
    })
    return () => {
      cancelled = true
    }
  }, [d.video_id, explicit.length])

  const keyframes = explicit.length ? explicit : fetched.keyframes
  const loading = !explicit.length && fetched.state === 'loading'
  const errored = !explicit.length && fetched.state === 'error'
  const empty = !explicit.length && !d.video_id

  // Chrome reveal (delete / grip + toolbar) mirrors the video block.
  const isHovered = useValue('hovered', () => editor.getHoveredShapeId() === shape.id, [editor, shape.id])
  const isSelected = useValue('selected', () => editor.getSelectedShapeIds().includes(shape.id), [editor, shape.id])
  const [chromeHover, setChromeHover] = useState(false)
  const showChrome = isHovered || isSelected || chromeHover

  // Peek: which keyframe is enlarged (index into `keyframes`), or null.
  const [peekIdx, setPeekIdx] = useState<number | null>(null)
  const [playing, setPlaying] = useState<{ startSec?: number } | null>(null)

  const trackRef = useRef<HTMLDivElement>(null)
  // Translate vertical wheel into horizontal scroll on the filmstrip (so a mouse
  // wheel scrubs the strip), and never let the gesture reach tldraw's zoom.
  const onWheel = (e: React.WheelEvent) => {
    const el = trackRef.current
    if (!el) return
    if (view === 'strip' && Math.abs(e.deltaY) > Math.abs(e.deltaX)) el.scrollLeft += e.deltaY
    e.stopPropagation()
  }

  const setData = useCallback(
    (patch: Partial<KeyframeTrackData>) => {
      const cur = editor.getShape<KeyframeTrackShape>(shape.id)
      if (!cur) return
      const next = { ...parseKeyframeData(cur.props.data), ...patch }
      editor.updateShape({ id: shape.id, type: KEYFRAME_TRACK, props: { data: JSON.stringify(next) } })
    },
    [editor, shape.id],
  )

  const setView = (v: KeyframeView) => setData({ view: v })

  const count = keyframes.length
  const title = d.title || 'Keyframes'

  return (
    <HTMLContainer>
      <div className={s.host}>
        <div className={s.card}>
          <div className={s.head}>
            <div className={s.headMain}>
              <FilmIcon />
              <span className={s.title}>{title}</span>
              {count > 0 ? <span className={s.count}>{count}</span> : null}
            </div>
            {count > 0 ? (
              <div className={s.viewToggle} onPointerDown={(e) => e.stopPropagation()}>
                {KEYFRAME_VIEW_OPTIONS.map((o) => (
                  <button
                    key={o.id}
                    className={`${s.viewBtn} ${view === o.id ? s.viewOn : ''}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setView(o.id)}
                    title={o.label}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          {empty ? (
            <EmptyPicker onPick={(video_id, ttl) => setData({ video_id, title: d.title || ttl || 'Keyframes' })} />
          ) : (
            <div
              ref={trackRef}
              className={`${s.track} ${view === 'grid' ? s.grid : s.strip}`}
              onWheel={onWheel}
              onPointerDown={(e) => e.stopPropagation()}
            >
              {loading
                ? Array.from({ length: 6 }).map((_, i) => <div key={i} className={s.tileSkeleton} />)
                : null}

              {!loading && errored ? (
                <div className={s.note}>Couldn’t load this video’s keyframes.</div>
              ) : null}

              {!loading && !errored && count === 0 ? (
                <div className={s.note}>No keyframes yet.</div>
              ) : null}

              {keyframes.map((kf, i) => (
                <Tile key={i} kf={kf} ordinal={i} onClick={() => setPeekIdx(i)} />
              ))}
            </div>
          )}
        </div>
      </div>

      <DeleteButton editor={editor} id={shape.id} show={showChrome} onHoverChange={setChromeHover} className="kt-trash" />
      <DragHandle editor={editor} id={shape.id} show={showChrome} onHoverChange={setChromeHover} className="kt-grip" />

      {peekIdx != null && keyframes[peekIdx] ? (
        <KeyframePeek
          kf={keyframes[peekIdx]}
          ordinal={peekIdx}
          total={count}
          canPlay={!!(d.video_id || d.source_url)}
          onPlay={() => {
            setPlaying({ startSec: keyframes[peekIdx]?.start_sec ?? undefined })
            setPeekIdx(null)
          }}
          onPrev={() => setPeekIdx((p) => (p == null ? p : Math.max(0, p - 1)))}
          onNext={() => setPeekIdx((p) => (p == null ? p : Math.min(count - 1, p + 1)))}
          onClose={() => setPeekIdx(null)}
        />
      ) : null}

      {playing ? (
        <VideoPeek
          videoId={d.video_id ?? null}
          sourceUrl={d.source_url ?? null}
          title={title}
          startSec={playing.startSec}
          onClose={() => setPlaying(null)}
        />
      ) : null}
    </HTMLContainer>
  )
}

/** A single keyframe tile: the still + its clip index + timecode badge. */
function Tile({ kf, ordinal, onClick }: { kf: Keyframe; ordinal: number; onClick: () => void }) {
  const src = resolveAssetUrl(kf.src) ?? ''
  const [broken, setBroken] = useState(false)
  const idxLabel = kf.idx != null ? kf.idx : ordinal + 1
  return (
    <button className={s.tile} onClick={onClick} title={kf.label || `Clip ${idxLabel}`}>
      <div className={s.tileMedia}>
        {src && !broken ? (
          <img src={src} alt="" className={s.tileImg} draggable={false} onError={() => setBroken(true)} />
        ) : (
          <div className={s.tileBroken}>
            <ImageGlyph />
          </div>
        )}
        <span className={s.tileIdx}>#{idxLabel}</span>
        {kf.start_sec != null ? <span className={s.tileTime}>{fmtTime(kf.start_sec)}</span> : null}
        {kf.shot_type ? <span className={s.tileShot}>{kf.shot_type.replace(/_/g, ' ')}</span> : null}
      </div>
    </button>
  )
}

/** Empty-state picker: choose one of the analysed videos to populate the track,
 * or paste a video id. Self-contained; uses the existing creator/video APIs. */
function EmptyPicker({ onPick }: { onPick: (videoId: string, title?: string) => void }) {
  const [open, setOpen] = useState(false)
  const [vids, setVids] = useState<{ id: string; title: string; creator: string }[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [manual, setManual] = useState('')

  const load = async () => {
    setOpen(true)
    if (vids || busy) return
    setBusy(true)
    const creators = await fetchCreators()
    const rows: { id: string; title: string; creator: string }[] = []
    for (const c of creators.slice(0, 8)) {
      const list = await fetchCreatorVideos(c.creator_id)
      for (const v of list?.videos ?? []) {
        if (v.status === 'analysed') rows.push({ id: v.video_id, title: v.title || 'Untitled', creator: c.name })
      }
    }
    setVids(rows)
    setBusy(false)
  }

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

  return (
    <div className={s.empty} onPointerDown={(e) => e.stopPropagation()}>
      {!open ? (
        <>
          <p className={s.emptyHint}>Visualise a video’s keyframes — pick an analysed video, or let the agent fill it from the avlana clips.</p>
          <button className={s.btn} onMouseDown={(e) => e.preventDefault()} onClick={load}>
            Choose a video
          </button>
        </>
      ) : (
        <div className={s.picker}>
          {busy ? <div className={s.note}>Loading analysed videos…</div> : null}
          {!busy && vids && vids.length === 0 ? <div className={s.note}>No analysed videos found.</div> : null}
          {!busy && vids && vids.length > 0 ? (
            <div className={s.pickerList}>
              {vids.map((v) => (
                <button
                  key={v.id}
                  className={s.pickerItem}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onPick(v.id, v.title)}
                  title={v.title}
                >
                  <span className={s.pickerTitle}>{v.title}</span>
                  <span className={s.pickerCreator}>{v.creator}</span>
                </button>
              ))}
            </div>
          ) : null}
          <div className={s.manualRow}>
            <input
              className={s.manualInput}
              placeholder="…or paste a video ID"
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              onPointerDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter' && UUID.test(manual.trim())) onPick(manual.trim())
              }}
            />
            <button
              className={s.btn}
              disabled={!UUID.test(manual.trim())}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => UUID.test(manual.trim()) && onPick(manual.trim())}
            >
              Load
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/** Centred peek overlay for one keyframe (portal to body, above the canvas). */
function KeyframePeek({
  kf,
  ordinal,
  total,
  canPlay,
  onPlay,
  onPrev,
  onNext,
  onClose,
}: {
  kf: Keyframe
  ordinal: number
  total: number
  canPlay: boolean
  onPlay: () => void
  onPrev: () => void
  onNext: () => void
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft') onPrev()
      else if (e.key === 'ArrowRight') onNext()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, onPrev, onNext])

  const src = resolveAssetUrl(kf.src) ?? ''
  const idxLabel = kf.idx != null ? kf.idx : ordinal + 1
  const span =
    kf.start_sec != null ? `${fmtTime(kf.start_sec)}${kf.end_sec != null ? ` – ${fmtTime(kf.end_sec)}` : ''}` : ''

  return createPortal(
    <div className={s.peekBackdrop} onPointerDown={onClose}>
      <div className={s.peek} onPointerDown={(e) => e.stopPropagation()}>
        <div className={s.peekStage}>
          {src ? <img src={src} alt="" className={s.peekImg} /> : <div className={s.peekBroken}>Image unavailable</div>}
          {ordinal > 0 ? (
            <button className={`${s.peekNav} ${s.peekPrev}`} onClick={onPrev} aria-label="Previous">‹</button>
          ) : null}
          {ordinal < total - 1 ? (
            <button className={`${s.peekNav} ${s.peekNext}`} onClick={onNext} aria-label="Next">›</button>
          ) : null}
        </div>
        <div className={s.peekBar}>
          <div className={s.peekMeta}>
            <span className={s.peekIdx}>Clip #{idxLabel}</span>
            {span ? <span className={s.peekTime}>{span}</span> : null}
            <span className={s.peekPos}>{ordinal + 1} / {total}</span>
            {kf.shot_type ? <span className={s.peekShot}>{kf.shot_type.replace(/_/g, ' ')}</span> : null}
          </div>
          <div className={s.peekActions}>
            {canPlay ? (
              <button className={`${s.btn} ${s.btnPrimary}`} onClick={onPlay}>
                <PlayGlyph /> Play from here
              </button>
            ) : null}
            <button className={s.btn} onClick={onClose}>Close</button>
          </div>
        </div>
        {kf.label ? <div className={s.peekCaption}>{kf.label}</div> : null}
      </div>
    </div>,
    document.body,
  )
}

function FilmIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4" />
    </svg>
  )
}

function ImageGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <circle cx="8.5" cy="8.5" r="1.6" />
      <path d="M21 15l-5-5L5 21" />
    </svg>
  )
}

function PlayGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 5v14l11-7z" />
    </svg>
  )
}
