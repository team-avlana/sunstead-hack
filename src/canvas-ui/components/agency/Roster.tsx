'use client'

import { useEffect, useState } from 'react'
import styles from './agency.module.css'
import { hasBackend } from '@/lib/api'
import { fetchRoster, fmtDate, type RosterRow } from '@/lib/agency'
import { Avatar, Sparkline, VerdictPill, Spinner, scoreColor } from './ui'
import type { Nav } from './AgencyApp'

const DIMS = [
  { key: 'hook', label: 'Hook' },
  { key: 'tone', label: 'Tone' },
  { key: 'pacing', label: 'Pacing' },
  { key: 'reference', label: 'Reference' },
] as const

function sortRows(rows: RosterRow[]): RosterRow[] {
  return [...rows].sort((a, b) => {
    // Creators with deliveries waiting to review float to the top (triage).
    if (!!b.pending_count !== !!a.pending_count) return b.pending_count - a.pending_count
    return (b.last_activity ?? '').localeCompare(a.last_activity ?? '')
  })
}

export default function Roster({ nav, onNew }: { nav: Nav; onNew: (id?: string) => void }) {
  const [rows, setRows] = useState<RosterRow[] | null>(null)

  useEffect(() => {
    let live = true
    fetchRoster().then((r) => live && setRows(r))
    // Light auto-refresh so deliveries that finish reviewing show up on the roster.
    const t = setInterval(() => fetchRoster().then((r) => live && setRows(r)), 8000)
    return () => {
      live = false
      clearInterval(t)
    }
  }, [])

  return (
    <div className={styles.page}>
      <div className={styles.pageHead}>
        <h1 className={styles.h1}>Roster</h1>
        <p className={styles.sub}>
          Every creator you coach, with their hook · tone · pacing · reference scores trending over
          time. Click a creator to see their deliveries, or start a new review.
        </p>
      </div>

      {!hasBackend() && (
        <div className={`${styles.banner} ${styles.bannerWarn}`}>
          No backend configured. Set <code>NEXT_PUBLIC_RAINY_API_URL</code> to your python-service to
          load the roster.
        </div>
      )}

      {rows === null ? (
        <div className={styles.empty}>
          <Spinner large />
        </div>
      ) : rows.length === 0 ? (
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>🎬</div>
          <div className={styles.emptyTitle}>No reviews yet</div>
          <p>Drop in a creator&apos;s delivery and a brief — get back a coaching note in minutes.</p>
          <button className={`${styles.btn} ${styles.btnPrimary}`} style={{ marginTop: 14 }} onClick={() => onNew()}>
            + New review
          </button>
        </div>
      ) : (
        <div className={styles.card}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Creator</th>
                <th className={styles.colNum}>Deliveries</th>
                {DIMS.map((d) => (
                  <th key={d.key} className={styles.colDim}>
                    {d.label}
                  </th>
                ))}
                <th>Latest</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {sortRows(rows).map((r) => (
                <tr key={r.creator_id} onClick={() => nav.creator(r.creator_id)}>
                  <td>
                    <div className={styles.creatorCell}>
                      <Avatar name={r.name} />
                      <div>
                        <div className={styles.creatorName}>{r.name}</div>
                        <div className={styles.creatorMeta}>
                          {r.platform || (r.kind === 'talent' ? 'UGC creator' : r.kind)}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className={styles.colNum}>
                    {r.delivery_count}
                    {r.pending_count > 0 && (
                      <span className={`${styles.pill} ${styles.pillPending}`} style={{ marginLeft: 6 }}>
                        {r.pending_count} new
                      </span>
                    )}
                  </td>
                  {DIMS.map((d) => {
                    const series = r.trend[d.key] ?? []
                    const latest = r.latest_scores?.[d.key]
                    return (
                      <td key={d.key}>
                        <div className={styles.dimCell}>
                          <span className={styles.dimScore} style={{ color: scoreColor(latest) }}>
                            {latest ?? '—'}
                          </span>
                          <Sparkline values={series} />
                        </div>
                      </td>
                    )
                  })}
                  <td>
                    <VerdictPill verdict={r.latest_verdict} />
                  </td>
                  <td className={styles.creatorMeta}>{fmtDate(r.last_activity)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
