'use client'

import { useEffect, useMemo, useState } from 'react'
import styles from './agency.module.css'
import {
  fetchCreatorDetail,
  fmtDate,
  fmtDuration,
  type CreatorDetail as Detail,
  type ReviewListItem,
} from '@/lib/agency'
import { Avatar, TrendChart, VerdictPill, Spinner, scoreColor, type TrendSeries } from './ui'
import type { Nav } from './AgencyApp'

const SERIES_DEFS = [
  { key: 'overall', label: 'Overall', color: '#0c76ff', dim: false },
  { key: 'hook', label: 'Hook', color: '#f59e0b', dim: true },
  { key: 'tone', label: 'Tone', color: '#7c5cf0', dim: true },
  { key: 'pacing', label: 'Pacing', color: '#0891b2', dim: true },
  { key: 'reference', label: 'Reference', color: '#16a34a', dim: true },
] as const

function buildSeries(reviews: ReviewListItem[]): TrendSeries[] {
  const ready = reviews.filter((r) => r.status === 'ready').slice().reverse() // oldest → newest
  return SERIES_DEFS.map((s) => ({
    label: s.label,
    color: s.color,
    values: ready
      .map((r) => (s.dim ? r.scores?.[s.key as 'hook'] : r.overall_score))
      .filter((v): v is number => typeof v === 'number'),
  })).filter((s) => s.values.length > 0)
}

function DeliveryRow({ r, onClick }: { r: ReviewListItem; onClick: () => void }) {
  const d = r.delivery
  return (
    <div className={styles.delivRow} onClick={onClick}>
      {d?.thumbnail ? (
        <img className={styles.thumb} src={d.thumbnail} alt="" />
      ) : (
        <span className={`${styles.thumb} ${styles.thumbEmpty}`}>🎞️</span>
      )}
      <div className={styles.delivMain}>
        <div className={styles.delivTitle}>{r.brief_title || d?.title || 'Delivery'}</div>
        <div className={styles.delivMeta}>
          {fmtDate(r.created_at)}
          {d?.duration_sec ? ` · ${fmtDuration(d.duration_sec)}` : ''}
          {r.status === 'analyzing' && d?.analysis_stage ? ` · ${d.analysis_stage.replace(/_/g, ' ')}` : ''}
        </div>
        {r.status === 'ready' && r.scores && (
          <div className={styles.miniScores}>
            {(['hook', 'tone', 'pacing', 'reference'] as const).map((k) =>
              r.scores?.[k] != null ? (
                <span key={k} className={styles.miniScore}>
                  {k[0].toUpperCase() + k.slice(1)} <b style={{ color: scoreColor(r.scores[k]) }}>{r.scores[k]}</b>
                </span>
              ) : null,
            )}
          </div>
        )}
      </div>
      <div className={styles.delivRight}>
        <VerdictPill verdict={r.verdict} status={r.status} />
        {r.status === 'ready' && r.overall_score != null && (
          <span style={{ fontWeight: 800, fontSize: 18, color: scoreColor(r.overall_score) }}>
            {r.overall_score}
          </span>
        )}
      </div>
    </div>
  )
}

export default function CreatorDetail({
  creatorId,
  nav,
  onNew,
}: {
  creatorId: string
  nav: Nav
  onNew: (id?: string) => void
}) {
  const [detail, setDetail] = useState<Detail | null>(null)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    let live = true
    const load = () =>
      fetchCreatorDetail(creatorId).then((d) => {
        if (!live) return
        if (d === null) setMissing(true)
        else setDetail(d)
      })
    load()
    const t = setInterval(load, 6000)
    return () => {
      live = false
      clearInterval(t)
    }
  }, [creatorId])

  const series = useMemo(() => (detail ? buildSeries(detail.reviews) : []), [detail])

  if (missing) {
    return (
      <div className={styles.page}>
        <div className={styles.empty}>
          <div className={styles.emptyTitle}>Creator not found</div>
          <button className={styles.btn} style={{ marginTop: 12 }} onClick={nav.roster}>
            ← Back to roster
          </button>
        </div>
      </div>
    )
  }
  if (!detail) {
    return (
      <div className={styles.page}>
        <div className={styles.empty}>
          <Spinner large />
        </div>
      </div>
    )
  }

  const { creator, reviews } = detail
  const ready = reviews.filter((r) => r.status === 'ready')
  const approvals = ready.filter((r) => r.verdict === 'approve').length
  const latestOverall = ready[0]?.overall_score ?? null

  return (
    <div className={styles.page}>
      <div className={styles.crumbs}>
        <span className={styles.crumbLink} onClick={nav.roster}>
          Roster
        </span>
        <span>/</span>
        <span>{creator.name}</span>
      </div>

      <div className={styles.creatorHead}>
        <Avatar name={creator.name} />
        <div style={{ flex: 1 }}>
          <h1 className={styles.creatorTitle}>{creator.name}</h1>
          <div className={styles.creatorMeta}>
            {creator.platform || 'UGC creator'} · {reviews.length} deliveries
          </div>
        </div>
        <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => onNew(creatorId)}>
          + New delivery
        </button>
      </div>

      <div className={styles.grid2}>
        <div className={`${styles.card} ${styles.cardPad}`}>
          <div className={styles.sectionTitle} style={{ marginTop: 0 }}>
            Improvement over time
          </div>
          {series.length ? (
            <>
              <TrendChart series={series} />
              <div className={styles.legend}>
                {series.map((s) => (
                  <span key={s.label} className={styles.legendItem}>
                    <span className={styles.legendSwatch} style={{ background: s.color }} />
                    {s.label}
                  </span>
                ))}
              </div>
            </>
          ) : (
            <p className={styles.sub} style={{ margin: 0 }}>
              Scores will trend here once this creator has a reviewed delivery.
            </p>
          )}
        </div>
        <div className={`${styles.card} ${styles.cardPad}`}>
          <div className={styles.sectionTitle} style={{ marginTop: 0 }}>
            At a glance
          </div>
          <div className={styles.statBlock}>
            <div className={styles.stat}>
              <div className={styles.statValue} style={{ color: scoreColor(latestOverall) }}>
                {latestOverall ?? '—'}
              </div>
              <div className={styles.statLabel}>Latest overall</div>
            </div>
            <div className={styles.stat}>
              <div className={styles.statValue}>{ready.length}</div>
              <div className={styles.statLabel}>Reviewed</div>
            </div>
            <div className={styles.stat}>
              <div className={styles.statValue}>
                {ready.length ? Math.round((approvals / ready.length) * 100) + '%' : '—'}
              </div>
              <div className={styles.statLabel}>Approval rate</div>
            </div>
          </div>
        </div>
      </div>

      <div className={styles.sectionTitle}>Deliveries</div>
      {reviews.length === 0 ? (
        <div className={`${styles.card} ${styles.empty}`} style={{ padding: 40 }}>
          <p>No deliveries yet for {creator.name}.</p>
          <button className={`${styles.btn} ${styles.btnPrimary}`} style={{ marginTop: 10 }} onClick={() => onNew(creatorId)}>
            + New delivery
          </button>
        </div>
      ) : (
        <div className={styles.card}>
          {reviews.map((r) => (
            <DeliveryRow key={r.review_id} r={r} onClick={() => nav.review(r.review_id)} />
          ))}
        </div>
      )}
    </div>
  )
}
