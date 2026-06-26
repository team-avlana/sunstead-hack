'use client'

import { useEffect, useRef, useState } from 'react'
import styles from './agency.module.css'
import {
  fetchReview,
  runReview,
  fmtDate,
  fmtDuration,
  DIMENSION_LABEL,
  type ReviewFull,
} from '@/lib/agency'
import type { VideoData } from '@/lib/blockTypes'
import { Donut, VerdictPill, ScoreBar, Spinner, scoreColor } from './ui'
import type { Nav } from './AgencyApp'

const VERDICT_LINE: Record<string, string> = {
  approve: 'On brief — ready to ship.',
  revise: 'Close — a few fixes before it ships.',
  reshoot: 'Misses the brief — worth another take.',
}

function MediaCard({ label, video }: { label: string; video: VideoData | null }) {
  if (!video) return null
  return (
    <div className={`${styles.card} ${styles.mediaCard}`}>
      {video.thumbnail ? (
        <img className={styles.mediaThumb} src={video.thumbnail} alt="" />
      ) : (
        <div className={`${styles.mediaThumb} ${styles.thumbEmpty}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 26 }}>
          🎞️
        </div>
      )}
      <div className={styles.mediaCap}>
        <div className={styles.mediaLabel}>{label}</div>
        <div className={styles.mediaName}>{video.title || video.source_url || 'Video'}</div>
        <div className={styles.creatorMeta}>
          {fmtDuration(video.duration_sec)}
          {video.status === 'error' ? ' · analysis failed' : video.status === 'analysing' ? ' · analysing…' : ''}
        </div>
        {video.hook?.text && <p className={styles.hookQuote}>“{video.hook.text}”</p>}
      </div>
    </div>
  )
}

export default function DeliveryDetail({ reviewId, nav }: { reviewId: string; nav: Nav }) {
  const [data, setData] = useState<ReviewFull | null>(null)
  const [missing, setMissing] = useState(false)
  const [copied, setCopied] = useState(false)
  const [rerunning, setRerunning] = useState(false)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    let live = true
    const load = () =>
      fetchReview(reviewId).then((d) => {
        if (!live) return
        if (d === null) {
          setMissing(true)
          return
        }
        setData(d)
        // Stop polling once the review settles.
        if (d.review.status !== 'analyzing' && timer.current) {
          clearInterval(timer.current)
          timer.current = null
        }
      })
    load()
    timer.current = setInterval(load, 4000)
    return () => {
      live = false
      if (timer.current) clearInterval(timer.current)
    }
  }, [reviewId])

  const copyNote = async () => {
    const note = data?.review.note
    if (!note) return
    try {
      await navigator.clipboard.writeText(note)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      /* clipboard blocked — ignore */
    }
  }

  const rerun = async () => {
    setRerunning(true)
    await runReview(reviewId)
    setRerunning(false)
    if (!timer.current) timer.current = setInterval(() => fetchReview(reviewId).then((d) => d && setData(d)), 4000)
    setData((d) => (d ? { ...d, review: { ...d.review, status: 'analyzing', error: null } } : d))
  }

  if (missing) {
    return (
      <div className={styles.page}>
        <div className={styles.empty}>
          <div className={styles.emptyTitle}>Review not found</div>
          <button className={styles.btn} style={{ marginTop: 12 }} onClick={nav.roster}>
            ← Back to roster
          </button>
        </div>
      </div>
    )
  }
  if (!data) {
    return (
      <div className={styles.page}>
        <div className={styles.empty}>
          <Spinner large />
        </div>
      </div>
    )
  }

  const { review, delivery, reference, creator } = data
  const dims = review.dimensions ?? []

  return (
    <div className={styles.page}>
      <div className={styles.crumbs}>
        <span className={styles.crumbLink} onClick={nav.roster}>
          Roster
        </span>
        <span>/</span>
        {creator && (
          <>
            <span className={styles.crumbLink} onClick={() => nav.creator(creator.creator_id)}>
              {creator.name}
            </span>
            <span>/</span>
          </>
        )}
        <span>{review.brief_title || 'Review'}</span>
      </div>

      {/* verdict hero */}
      <div className={`${styles.card} ${styles.verdictHero}`}>
        <Donut score={review.status === 'ready' ? review.overall_score : null} />
        <div className={styles.verdictTexts}>
          <div className={styles.verdictBig}>
            {review.brief_title || delivery?.title || 'Delivery review'}
          </div>
          <div className={styles.verdictSub}>
            {review.status === 'ready'
              ? (review.verdict ? VERDICT_LINE[review.verdict] : '') + ` · reviewed ${fmtDate(review.updated_at)}`
              : review.status === 'failed'
                ? 'Review could not be generated.'
                : 'Analysing the delivery and writing the coaching note…'}
          </div>
        </div>
        <VerdictPill verdict={review.verdict} status={review.status} />
      </div>

      {review.status === 'failed' && (
        <div className={`${styles.banner} ${styles.bannerWarn}`}>
          <span>⚠️ {review.error || 'Something went wrong.'}</span>
          <div className={styles.spacer} />
          <button className={`${styles.btn} ${styles.btnSm}`} onClick={rerun} disabled={rerunning}>
            {rerunning ? 'Re-running…' : 'Re-run review'}
          </button>
        </div>
      )}

      {review.status === 'analyzing' && (
        <div className={`${styles.banner} ${styles.bannerInfo}`}>
          <Spinner />
          <span>
            {delivery?.status === 'analysing'
              ? 'Analysing the delivery…'
              : 'Generating the coaching note…'}
          </span>
        </div>
      )}

      <div className={styles.reviewGrid}>
        <div>
          {(delivery || reference) && (
            <div className={styles.mediaRow} style={{ marginBottom: 18 }}>
              <MediaCard label="Delivery" video={delivery} />
              {reference && <MediaCard label="Reference" video={reference} />}
            </div>
          )}

          {review.status === 'ready' && (
            <>
              <div className={`${styles.card} ${styles.cardPad}`}>
                <div className={styles.sectionTitle} style={{ marginTop: 0 }}>
                  Scorecard
                </div>
                <div className={styles.dimList}>
                  {dims.map((d) => (
                    <div key={d.key} className={styles.dimItem}>
                      <div className={styles.dimHead}>
                        <span className={styles.dimName}>{DIMENSION_LABEL[d.key] || d.label}</span>
                        <ScoreBar score={d.score} />
                        <span className={styles.dimScore} style={{ color: scoreColor(d.score) }}>
                          {d.score}
                        </span>
                      </div>
                      {d.comment && <div className={styles.dimComment}>{d.comment}</div>}
                    </div>
                  ))}
                </div>
              </div>

              {((review.strengths?.length ?? 0) > 0 || (review.missing?.length ?? 0) > 0) && (
                <div className={styles.grid2} style={{ marginTop: 18 }}>
                  {(review.strengths?.length ?? 0) > 0 && (
                    <div className={`${styles.card} ${styles.cardPad}`}>
                      <div className={styles.sectionTitle} style={{ marginTop: 0 }}>
                        Strengths
                      </div>
                      <div className={styles.chips}>
                        {review.strengths!.map((s, i) => (
                          <div key={i} className={`${styles.chip} ${styles.chipGood}`}>
                            <span className={styles.chipIcon}>✓</span>
                            <span>{s}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {(review.missing?.length ?? 0) > 0 && (
                    <div className={`${styles.card} ${styles.cardPad}`}>
                      <div className={styles.sectionTitle} style={{ marginTop: 0 }}>
                        Missing from the brief
                      </div>
                      <div className={styles.chips}>
                        {review.missing!.map((s, i) => (
                          <div key={i} className={`${styles.chip} ${styles.chipMiss}`}>
                            <span className={styles.chipIcon}>!</span>
                            <span>{s}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* coaching note */}
        <div>
          <div className={`${styles.card} ${styles.noteCard}`}>
            <div className={styles.noteHead}>
              <span className={styles.noteTitle}>💬 Coaching note</span>
              {review.note && (
                <button className={`${styles.btn} ${styles.btnSm} ${styles.btnPrimary}`} onClick={copyNote}>
                  {copied ? 'Copied!' : 'Copy'}
                </button>
              )}
            </div>
            <div className={styles.noteBody}>
              {review.note ? (
                review.note
              ) : review.status === 'analyzing' ? (
                <span className={styles.analyzing}>
                  <Spinner /> Writing the note…
                </span>
              ) : (
                <span className={styles.creatorMeta}>No note yet.</span>
              )}
            </div>
          </div>
          {review.brief && (
            <div className={`${styles.card} ${styles.cardPad}`} style={{ marginTop: 18 }}>
              <div className={styles.sectionTitle} style={{ marginTop: 0 }}>
                Brief
              </div>
              <div style={{ fontSize: 13.5, lineHeight: 1.55, whiteSpace: 'pre-wrap', color: '#3a4150' }}>
                {review.brief}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
