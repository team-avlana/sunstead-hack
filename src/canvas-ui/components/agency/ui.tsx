'use client'

import styles from './agency.module.css'
import type { Verdict, ReviewStatus } from '@/lib/agency'

// ── colour scales ────────────────────────────────────────────────────────────

/** Score → colour. Consistent everywhere a 0-100 score appears. */
export function scoreColor(score: number | null | undefined): string {
  if (score == null) return '#9aa3b2'
  if (score < 50) return '#dc2626'
  if (score < 70) return '#d97706'
  if (score < 85) return '#0c76ff'
  return '#16a34a'
}

const AVATAR_COLORS = [
  ['#5b8def', '#3b6ef6'],
  ['#f97393', '#e84d6f'],
  ['#34d399', '#0ea371'],
  ['#fbbf66', '#f59e0b'],
  ['#a78bfa', '#7c5cf0'],
  ['#22d3ee', '#0891b2'],
]

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

export function Avatar({ name, className }: { name: string; className?: string }) {
  const [a, b] = AVATAR_COLORS[hash(name) % AVATAR_COLORS.length]
  return (
    <span
      className={`${styles.avatar} ${className ?? ''}`}
      style={{ background: `linear-gradient(140deg, ${a}, ${b})` }}
    >
      {initials(name)}
    </span>
  )
}

// ── verdict / status pill ─────────────────────────────────────────────────────

const VERDICT_TEXT: Record<Verdict, string> = {
  approve: 'Approve',
  revise: 'Revise',
  reshoot: 'Reshoot',
}

export function VerdictPill({
  verdict,
  status,
}: {
  verdict: Verdict | null
  status?: ReviewStatus
}) {
  if (status === 'analyzing') {
    return (
      <span className={`${styles.pill} ${styles.pillPending}`}>
        <span className={styles.spinner} style={{ width: 11, height: 11, borderWidth: 2 }} />
        Reviewing
      </span>
    )
  }
  if (status === 'failed') {
    return <span className={`${styles.pill} ${styles.pillFailed}`}>Failed</span>
  }
  if (!verdict) return <span className={`${styles.pill} ${styles.pillFailed}`}>—</span>
  const cls =
    verdict === 'approve'
      ? styles.pillApprove
      : verdict === 'revise'
        ? styles.pillRevise
        : styles.pillReshoot
  return (
    <span className={`${styles.pill} ${cls}`}>
      <span className={styles.pillDot} />
      {VERDICT_TEXT[verdict]}
    </span>
  )
}

// ── score bar ─────────────────────────────────────────────────────────────────

export function ScoreBar({ score }: { score: number | null | undefined }) {
  const pct = Math.max(0, Math.min(100, score ?? 0))
  return (
    <span className={styles.bar}>
      <span
        className={styles.barFill}
        style={{ width: `${pct}%`, background: scoreColor(score) }}
      />
    </span>
  )
}

// ── sparkline (inline trend in a table cell) ──────────────────────────────────

export function Sparkline({
  values,
  width = 60,
  height = 22,
}: {
  values: number[]
  width?: number
  height?: number
}) {
  if (!values.length) return <span style={{ color: '#c2c8d4', fontSize: 12 }}>—</span>
  const last = values[values.length - 1]
  const color = scoreColor(last)
  if (values.length === 1) {
    return (
      <svg width={width} height={height} aria-hidden>
        <circle cx={width - 3} cy={height / 2} r={3} fill={color} />
      </svg>
    )
  }
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const pad = 3
  const stepX = (width - pad * 2) / (values.length - 1)
  const pts = values.map((v, i) => {
    const x = pad + i * stepX
    const y = pad + (1 - (v - min) / span) * (height - pad * 2)
    return [x, y] as const
  })
  const d = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  return (
    <svg width={width} height={height} aria-hidden>
      <path d={d} fill="none" stroke={color} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r={2.5} fill={color} />
    </svg>
  )
}

// ── multi-series trend chart (creator detail) ─────────────────────────────────

export interface TrendSeries {
  label: string
  color: string
  values: number[]
}

export function TrendChart({ series, height = 200 }: { series: TrendSeries[]; height?: number }) {
  const width = 640
  const padL = 30
  const padR = 12
  const padT = 12
  const padB = 22
  const maxLen = Math.max(0, ...series.map((s) => s.values.length))
  if (maxLen < 1) return null
  const innerW = width - padL - padR
  const innerH = height - padT - padB
  const x = (i: number) => padL + (maxLen === 1 ? innerW / 2 : (i / (maxLen - 1)) * innerW)
  const y = (v: number) => padT + (1 - v / 100) * innerH

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className={styles.trendChart} role="img" aria-label="Score trend">
      {[0, 25, 50, 75, 100].map((g) => (
        <g key={g}>
          <line x1={padL} y1={y(g)} x2={width - padR} y2={y(g)} stroke="rgba(18,24,48,0.07)" strokeWidth={1} />
          <text x={padL - 6} y={y(g) + 3} textAnchor="end" fontSize={9} fill="#9aa3b2">
            {g}
          </text>
        </g>
      ))}
      {series.map((s) => {
        if (!s.values.length) return null
        const d = s.values
          .map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`)
          .join(' ')
        return (
          <g key={s.label}>
            <path d={d} fill="none" stroke={s.color} strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round" />
            {s.values.map((v, i) => (
              <circle key={i} cx={x(i)} cy={y(v)} r={2.75} fill={s.color} />
            ))}
          </g>
        )
      })}
    </svg>
  )
}

// ── score donut (review verdict hero) ─────────────────────────────────────────

export function Donut({ score, size = 76 }: { score: number | null | undefined; size?: number }) {
  const r = size / 2 - 6
  const c = 2 * Math.PI * r
  const pct = Math.max(0, Math.min(100, score ?? 0))
  const color = scoreColor(score)
  return (
    <svg width={size} height={size} className={styles.donut}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(18,24,48,0.09)" strokeWidth={6} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={6}
        strokeLinecap="round"
        strokeDasharray={`${(pct / 100) * c} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text x="50%" y="50%" textAnchor="middle" dominantBaseline="central" fontSize={size * 0.3} fontWeight={800} fill={color}>
        {score == null ? '—' : Math.round(score)}
      </text>
    </svg>
  )
}

export function Spinner({ large }: { large?: boolean }) {
  return <span className={`${styles.spinner} ${large ? styles.spinnerLg : ''}`} />
}
