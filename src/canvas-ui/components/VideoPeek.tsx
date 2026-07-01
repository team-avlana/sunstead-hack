'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import s from './VideoPeek.module.css'
import { resolveAssetUrl } from '@/lib/api'
import { deleteMappedVideo, getMappedVideo, mapKeyFor, setMappedVideo } from '@/lib/localVideoMap'

/**
 * Centre-screen video peek — plays a clip back over the canvas (portal to body).
 *
 * Source resolution, in order:
 *   1. a directly-playable media URL (a hosted .mp4/.webm/… — e.g. an avlana clip
 *      with real media) → native <video>.
 *   2. a local file the user previously "mapped" (IndexedDB) → native <video>.
 *   3. a recognised embed (YouTube / Vimeo) → <iframe>.
 *   4. otherwise → the "link a local video to map it" state. Most platform
 *      sources (a TikTok / IG *page* URL) land here because the page isn't a
 *      playable file; the user links a local copy once and it's remembered.
 *
 * `startSec` seeks a native <video> (and is passed to YouTube/Vimeo embeds) so a
 * "play from here" on a keyframe starts at that cut.
 */
export function VideoPeek({
  videoId,
  sourceUrl,
  title,
  startSec,
  onClose,
}: {
  videoId?: string | null
  sourceUrl?: string | null
  title?: string | null
  startSec?: number
  onClose: () => void
}) {
  type Mode = 'resolving' | 'file' | 'local' | 'embed' | 'needsMap'
  const key = mapKeyFor(videoId, sourceUrl)
  const [mode, setMode] = useState<Mode>('resolving')
  const [src, setSrc] = useState<string | null>(null)
  const [embed, setEmbed] = useState<string | null>(null)
  const objUrlRef = useRef<string | null>(null)

  const revoke = () => {
    if (objUrlRef.current) {
      URL.revokeObjectURL(objUrlRef.current)
      objUrlRef.current = null
    }
  }

  useEffect(() => {
    let cancelled = false
    const direct = directMediaUrl(sourceUrl)
    if (direct) {
      setSrc(direct)
      setMode('file')
      return
    }
    void getMappedVideo(key).then((m) => {
      if (cancelled) return
      if (m) {
        const u = URL.createObjectURL(m.blob)
        objUrlRef.current = u
        setSrc(u)
        setMode('local')
        return
      }
      const emb = embedFor(sourceUrl, startSec)
      if (emb) {
        setEmbed(emb)
        setMode('embed')
        return
      }
      setMode('needsMap')
    })
    return () => {
      cancelled = true
    }
    // startSec intentionally not a dep — it only seeds the embed URL / initial seek.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, sourceUrl])

  useEffect(() => () => revoke(), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const onPick = useCallback(
    (file: File) => {
      revoke()
      const u = URL.createObjectURL(file)
      objUrlRef.current = u
      setSrc(u)
      setMode('local')
      void setMappedVideo(key, file)
    },
    [key],
  )

  const onUnlink = useCallback(() => {
    revoke()
    setSrc(null)
    void deleteMappedVideo(key)
    const emb = embedFor(sourceUrl, startSec)
    if (emb) {
      setEmbed(emb)
      setMode('embed')
    } else setMode('needsMap')
  }, [key, sourceUrl, startSec])

  const applyStart = (v: HTMLVideoElement) => {
    if (startSec && startSec > 0 && isFinite(startSec)) {
      try {
        v.currentTime = startSec
      } catch {
        /* seek not ready */
      }
    }
  }

  return createPortal(
    <div className={s.backdrop} onPointerDown={onClose}>
      <div className={s.modal} onPointerDown={(e) => e.stopPropagation()}>
        <div className={s.bar}>
          <span className={s.title}>{title || 'Video'}</span>
          <div className={s.actions}>
            {sourceUrl ? (
              <a className={s.link} href={sourceUrl} target="_blank" rel="noreferrer">
                Open original ↗
              </a>
            ) : null}
            {mode === 'local' ? (
              <>
                <label className={s.btn}>
                  Replace
                  <input
                    type="file"
                    accept="video/*"
                    hidden
                    onChange={(e) => {
                      const f = e.target.files?.[0]
                      if (f) onPick(f)
                    }}
                  />
                </label>
                <button className={s.btn} onClick={onUnlink}>
                  Unlink
                </button>
              </>
            ) : null}
            <button className={s.btn} onClick={onClose} aria-label="Close">
              Close
            </button>
          </div>
        </div>

        <div className={s.stage}>
          {mode === 'resolving' ? <div className={s.note}>Loading…</div> : null}

          {(mode === 'file' || mode === 'local') && src ? (
            <video
              className={s.video}
              src={src}
              controls
              autoPlay
              playsInline
              onLoadedMetadata={(e) => applyStart(e.currentTarget)}
            />
          ) : null}

          {mode === 'embed' && embed ? (
            <iframe
              className={s.frame}
              src={embed}
              title={title || 'Video'}
              allow="autoplay; fullscreen; picture-in-picture; encrypted-media"
              allowFullScreen
            />
          ) : null}

          {mode === 'needsMap' ? <NeedsMap persists={!!key} onPick={onPick} /> : null}
        </div>

        {mode === 'local' ? (
          <div className={s.foot}>
            Playing a local file you linked{key ? ' — saved on this device for this clip.' : ' (this session only).'}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  )
}

function NeedsMap({ persists, onPick }: { persists: boolean; onPick: (f: File) => void }) {
  return (
    <div className={s.needs}>
      <div className={s.needsGlyph}>
        <LinkGlyph />
      </div>
      <div className={s.needsTitle}>This source can’t be played here</div>
      <p className={s.needsBody}>
        The original is a platform page, not a video file, so it can’t stream inside the canvas. Link a local copy of the
        video to map it to this clip{persists ? ' — it’ll be remembered next time.' : '.'}
      </p>
      <label className={`${s.btn} ${s.btnPrimary}`}>
        Link a local video
        <input
          type="file"
          accept="video/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) onPick(f)
          }}
        />
      </label>
    </div>
  )
}

// ── source helpers ───────────────────────────────────────────────────────────

const MEDIA_RE = /\.(mp4|m4v|webm|ogv|ogg|mov)(\?|#|$)/i

/** A URL a <video> can load directly (a hosted media file, blob: or data:). */
function directMediaUrl(url?: string | null): string | null {
  if (!url) return null
  if (url.startsWith('blob:') || url.startsWith('data:')) return url
  const resolved = resolveAssetUrl(url) ?? url
  return MEDIA_RE.test(resolved) ? resolved : null
}

/** A YouTube / Vimeo watch URL → its embed URL (with a start time when given). */
function embedFor(url?: string | null, startSec?: number): string | null {
  if (!url) return null
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  const host = u.hostname.replace(/^www\./, '')
  const start = startSec && startSec > 0 ? Math.floor(startSec) : 0
  if (host === 'youtube.com' || host === 'm.youtube.com') {
    const v = u.searchParams.get('v')
    if (v) return `https://www.youtube.com/embed/${v}?autoplay=1${start ? `&start=${start}` : ''}`
  }
  if (host === 'youtu.be') {
    const id = u.pathname.slice(1)
    if (id) return `https://www.youtube.com/embed/${id}?autoplay=1${start ? `&start=${start}` : ''}`
  }
  if (host === 'vimeo.com') {
    const id = u.pathname.split('/').filter(Boolean)[0]
    if (id && /^\d+$/.test(id)) return `https://player.vimeo.com/video/${id}?autoplay=1${start ? `#t=${start}s` : ''}`
  }
  return null
}

function LinkGlyph() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  )
}
