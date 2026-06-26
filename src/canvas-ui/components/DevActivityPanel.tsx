'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  connectDevEvents,
  devPanelEnabled,
  toActivityRows,
  type ActivityRow,
  type DevEvent,
} from '@/lib/devEvents'
import styles from './DevActivityPanel.module.css'

/**
 * Dev-only "Service Activity" panel — a live view of what the python-service is
 * doing and how long it takes. Streams timed spans (HTTP requests, image
 * generation, analysis lifecycle) and forwarded backend logs over /dev/events.
 *
 * Rendered as a constant sibling of <RightPanel/> but self-gates to nothing
 * unless NEXT_PUBLIC_RAINY_DEV_PANEL is set, so it ships invisibly in prod.
 */

const MAX_EVENTS = 2000 // ring kept in memory; rows are derived + capped for render
const MAX_ROWS = 400
const SLOW_MS = 1500 // spans slower than this are flagged amber

type ConnStatus = 'connected' | 'reconnecting' | 'disabled'

function fmtTime(ts: number): string {
  const d = new Date(ts * 1000)
  return d.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0')
}

function fmtDur(ms: number): string {
  if (ms < 1) return '<1ms'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)}s`
}

function Row({ r }: { r: ActivityRow }) {
  const catClass = styles[r.category] ? `${styles.cat} ${styles[r.category]}` : `${styles.cat} ${styles.log}`
  let right: React.ReactNode
  if (r.kind === 'span' && r.status === 'running') {
    right = (
      <span className={styles.running}>
        <span className={styles.spin} />
        running
      </span>
    )
  } else if (r.kind === 'span' && r.durationMs != null) {
    const cls =
      r.status === 'error' ? styles.error : r.durationMs > SLOW_MS ? styles.slow : styles.ok
    right = <span className={`${styles.dur} ${cls}`}>{fmtDur(r.durationMs)}</span>
  } else {
    // log row — colour by level
    right = <span className={styles[`lvl${r.status}`] || styles.detail}>{r.status}</span>
  }

  return (
    <div className={styles.row}>
      <span className={styles.time}>{fmtTime(r.ts)}</span>
      <span className={catClass}>{r.category}</span>
      <span className={styles.name} title={`${r.name}${r.detail ? ` — ${r.detail}` : ''}`}>
        {r.name}
        {r.detail ? <span className={styles.detail}> · {r.detail}</span> : null}
      </span>
      {right}
    </div>
  )
}

export default function DevActivityPanel() {
  // Hooks must run unconditionally; we bail in render below if the panel is off.
  const enabled = devPanelEnabled()
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<ConnStatus>('reconnecting')
  const [events, setEvents] = useState<DevEvent[]>([])
  const [paused, setPaused] = useState(false)
  const [activeCats, setActiveCats] = useState<Set<string>>(new Set())
  const pausedRef = useRef(paused)
  pausedRef.current = paused

  useEffect(() => {
    if (!enabled) return
    const append = (incoming: DevEvent[]) => {
      if (pausedRef.current) return
      setEvents((prev) => {
        const next = prev.concat(incoming)
        return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next
      })
    }
    return connectDevEvents({
      onStatus: setStatus,
      onBacklog: (evs) => setEvents(evs.slice(-MAX_EVENTS)),
      onEvent: (e) => append([e]),
    })
  }, [enabled])

  const rows = useMemo(() => toActivityRows(events), [events])
  const cats = useMemo(() => Array.from(new Set(rows.map((r) => r.category))).sort(), [rows])
  const shown = useMemo(() => {
    const filtered = activeCats.size ? rows.filter((r) => activeCats.has(r.category)) : rows
    return filtered.slice(0, MAX_ROWS)
  }, [rows, activeCats])

  const runningCount = useMemo(
    () => rows.filter((r) => r.kind === 'span' && r.status === 'running').length,
    [rows],
  )

  if (!enabled) return null

  const toggleCat = (c: string) =>
    setActiveCats((prev) => {
      const next = new Set(prev)
      if (next.has(c)) next.delete(c)
      else next.add(c)
      return next
    })

  if (!open) {
    return (
      <button className={styles.toggle} onClick={() => setOpen(true)} title="Service activity (dev)">
        <span className={`${styles.dot} ${styles[status]}`} />
        Activity
        {runningCount > 0 ? ` · ${runningCount}` : ''}
      </button>
    )
  }

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.title}>
          <span className={`${styles.dot} ${styles[status]}`} />
          Service Activity
          <span className={styles.count}>
            {status === 'disabled'
              ? 'backend off (set RAINY_DEV_LOGS=1)'
              : `${rows.length} events${runningCount ? ` · ${runningCount} running` : ''}`}
          </span>
        </span>
        <button
          className={`${styles.iconBtn} ${paused ? styles.active : ''}`}
          onClick={() => setPaused((p) => !p)}
          title={paused ? 'Resume stream' : 'Pause stream'}
        >
          {paused ? '▶ resume' : '❚❚ pause'}
        </button>
        <button className={styles.iconBtn} onClick={() => setEvents([])} title="Clear">
          clear
        </button>
        <button className={styles.iconBtn} onClick={() => setOpen(false)} title="Close">
          ✕
        </button>
      </div>

      {cats.length > 0 && (
        <div className={styles.filters}>
          {cats.map((c) => (
            <button
              key={c}
              className={`${styles.chip} ${activeCats.has(c) ? styles.on : ''}`}
              onClick={() => toggleCat(c)}
            >
              {c}
            </button>
          ))}
        </div>
      )}

      <div className={styles.list}>
        {shown.length === 0 ? (
          <div className={styles.empty}>
            {status === 'disabled'
              ? 'Backend dev logs are off. Start python-service with RAINY_DEV_LOGS=1.'
              : 'Waiting for activity…'}
          </div>
        ) : (
          shown.map((r) => <Row key={r.key} r={r} />)
        )}
      </div>
    </div>
  )
}
