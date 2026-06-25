'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  analyzeChannel,
  buildStyleProfile,
  fetchChannelAnalysis,
  fetchCreators,
  fetchSelfCreator,
  fetchStyleProfile,
  hasBackend,
  type Creator,
  type SelfCreator,
  type StyleProfile,
} from '@/lib/api'
import styles from './CreatorStudio.module.css'

/**
 * Creator Studio — the home-screen hub for the channel → analysis → style-profile
 * pipeline that the backend already runs but the canvas never surfaced.
 *
 *   • Channel ingest (#3): onboard the user's own channel and add reference
 *     channels; each kicks off background analysis with a live progress bar.
 *   • Style DNA (#2): render the aggregated style profile (summary + facets),
 *     with a build/refresh button that triggers and polls the aggregation.
 *
 * Renders nothing without a backend (the canvas still works fully offline).
 */
export default function CreatorStudio() {
  const [self, setSelf] = useState<SelfCreator | null>(null)
  const [profile, setProfile] = useState<StyleProfile | null>(null)
  const [refs, setRefs] = useState<Creator[]>([])
  const [progress, setProgress] = useState<Record<string, { done: number; total: number }>>({})
  const [loaded, setLoaded] = useState(false)
  const [building, setBuilding] = useState(false)
  const buildBaseline = useRef<string | null>(null)

  // `active` (a ref so the poll reads the latest without re-subscribing) is true
  // while any channel is still analysing or a style build is in flight.
  const activeRef = useRef(false)

  const load = useCallback(async () => {
    if (!hasBackend()) return
    const s = await fetchSelfCreator()
    setSelf(s)
    const references = await fetchCreators('reference')
    setRefs(references)

    const [prof, ...refProg] = await Promise.all([
      s ? fetchStyleProfile(s.creator_id) : Promise.resolve(null),
      ...references.map((r) => fetchChannelAnalysis(r.creator_id)),
    ])
    setProfile(prof)

    const prog: Record<string, { done: number; total: number }> = {}
    references.forEach((r, i) => {
      const p = refProg[i]
      if (p) prog[r.creator_id] = { done: p.done, total: p.total }
    })
    setProgress(prog)

    // A newer profile timestamp than the build baseline means the build finished.
    if (building && prof && prof.created_at !== buildBaseline.current) setBuilding(false)

    const selfActive = !!s && s.video_count > 0 && s.analyzed_count < s.video_count
    const refsActive = references.some((r) => {
      const p = prog[r.creator_id]
      return p && p.total > 0 && p.done < p.total
    })
    activeRef.current = selfActive || refsActive || building
    setLoaded(true)
  }, [building])

  useEffect(() => {
    void load()
    const poll = window.setInterval(() => {
      if (activeRef.current && !document.hidden) void load()
    }, 6000)
    return () => window.clearInterval(poll)
  }, [load])

  if (!hasBackend()) return null
  if (!loaded) return null

  const onAddChannel = async (url: string, kind: 'self' | 'reference', name?: string) => {
    const res = await analyzeChannel(url, kind, name)
    if (res) {
      activeRef.current = true
      await load()
    }
    return !!res
  }

  const onBuildProfile = async () => {
    if (!self) return
    buildBaseline.current = profile?.created_at ?? null
    setBuilding(true)
    activeRef.current = true
    const ok = await buildStyleProfile(self.creator_id)
    if (!ok) setBuilding(false)
  }

  const onboarded = !!self?.channel_url

  return (
    <section className={styles.studio}>
      <div className={styles.head}>
        <span className={styles.title}>Creator Studio</span>
        <span className={styles.sub}>Your channel DNA &amp; references</span>
      </div>

      {/* ── Your channel ─────────────────────────────────────────────── */}
      <div className={styles.block}>
        <div className={styles.blockHead}>Your channel</div>
        {onboarded ? (
          <ChannelRow
            name={self!.name}
            url={self!.channel_url}
            done={self!.analyzed_count}
            total={self!.video_count}
          />
        ) : (
          <AddChannel
            kind="self"
            placeholder="Paste your YouTube / TikTok channel URL"
            cta="Analyse my channel"
            onAdd={(url) => onAddChannel(url, 'self')}
          />
        )}
      </div>

      {/* ── Style DNA ────────────────────────────────────────────────── */}
      <div className={styles.block}>
        <div className={styles.blockHead}>
          Style DNA
          {self && (
            <button
              className={styles.ghostBtn}
              onClick={onBuildProfile}
              disabled={building || (self.video_count === 0)}
              title={self.video_count === 0 ? 'Analyse a channel first' : undefined}
            >
              {building ? 'Building…' : profile ? 'Refresh' : 'Build'}
            </button>
          )}
        </div>
        <StyleDna profile={profile} building={building} canBuild={(self?.video_count ?? 0) > 0} />
      </div>

      {/* ── Reference channels ───────────────────────────────────────── */}
      <div className={styles.block}>
        <div className={styles.blockHead}>Reference channels</div>
        {refs.length > 0 && (
          <div className={styles.refList}>
            {refs.map((r) => {
              const p = progress[r.creator_id]
              return (
                <ChannelRow
                  key={r.creator_id}
                  name={r.name}
                  url={r.channel_url}
                  done={p?.done ?? 0}
                  total={p?.total ?? 0}
                  compact
                />
              )
            })}
          </div>
        )}
        <AddChannel
          kind="reference"
          placeholder="Add a competitor or inspiration channel"
          cta="Add reference"
          withName
          onAdd={(url, name) => onAddChannel(url, 'reference', name)}
        />
      </div>
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

function ChannelRow({
  name,
  url,
  done,
  total,
  compact,
}: {
  name: string
  url: string | null
  done: number
  total: number
  compact?: boolean
}) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  const complete = total > 0 && done >= total
  return (
    <div className={`${styles.channel}${compact ? ' ' + styles.channelCompact : ''}`}>
      <div className={styles.channelMain}>
        <span className={styles.channelName} title={url ?? undefined}>
          {name}
        </span>
        <span className={styles.channelMeta}>
          {total === 0 ? 'No videos yet' : complete ? `${total} analysed` : `${done}/${total} analysed`}
        </span>
      </div>
      {total > 0 && !complete && (
        <div className={styles.bar}>
          <div className={styles.barFill} style={{ width: `${Math.max(pct, 6)}%` }} />
        </div>
      )}
    </div>
  )
}

function StyleDna({
  profile,
  building,
  canBuild,
}: {
  profile: StyleProfile | null
  building: boolean
  canBuild: boolean
}) {
  if (building && !profile) {
    return <p className={styles.muted}>Aggregating your style across every analysed video…</p>
  }
  if (!profile) {
    return (
      <p className={styles.muted}>
        {canBuild
          ? 'Build a style profile to capture your hooks, pacing, voice, and visual signature.'
          : 'Analyse your channel, then build a style profile to see your content DNA here.'}
      </p>
    )
  }
  const facets = extractFacets(profile.profile)
  return (
    <div className={styles.dna}>
      {profile.summary && <p className={styles.summary}>{profile.summary}</p>}
      {facets.length > 0 && (
        <dl className={styles.facets}>
          {facets.map((f) => (
            <div key={f.label} className={styles.facet}>
              <dt className={styles.facetLabel}>{f.label}</dt>
              <dd className={styles.facetValue}>{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {building && <p className={styles.muted}>Refreshing…</p>}
    </div>
  )
}

function AddChannel({
  kind,
  placeholder,
  cta,
  withName,
  onAdd,
}: {
  kind: 'self' | 'reference'
  placeholder: string
  cta: string
  withName?: boolean
  onAdd: (url: string, name?: string) => Promise<boolean>
}) {
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    const trimmed = url.trim()
    if (!trimmed || busy) return
    setBusy(true)
    setErr(null)
    const ok = await onAdd(trimmed, withName ? name.trim() || undefined : undefined)
    setBusy(false)
    if (ok) {
      setUrl('')
      setName('')
    } else {
      setErr('Could not start analysis — check the URL.')
    }
  }

  return (
    <div className={styles.add}>
      {withName && (
        <input
          className={styles.input}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name (optional)"
          aria-label={`${kind} channel name`}
        />
      )}
      <div className={styles.addRow}>
        <input
          className={styles.input}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder={placeholder}
          aria-label={`${kind} channel URL`}
        />
        <button className={styles.primaryBtn} onClick={submit} disabled={busy || !url.trim()}>
          {busy ? '…' : cta}
        </button>
      </div>
      {err && <span className={styles.err}>{err}</span>}
    </div>
  )
}

// ── style-profile facet extraction (defensive against schema drift) ──────────

const FACET_LABELS: Record<string, string> = {
  style_summary: 'Style',
  hook_patterns: 'Hooks',
  pacing_style: 'Pacing',
  visual_style: 'Visual',
  editing_style: 'Editing',
  voice_tone: 'Voice & tone',
  cta_patterns: 'CTAs',
  retention_tactics: 'Retention',
  topics_niche: 'Topics',
  content_structure: 'Structure',
  differentiation_points: 'Differentiation',
}

/** The profile jsonb may be flat or nested under `.style` — normalise to one map. */
function asStyle(profile: Record<string, unknown> | null): Record<string, unknown> {
  if (!profile) return {}
  const style = (profile as Record<string, unknown>).style
  return style && typeof style === 'object' ? (style as Record<string, unknown>) : profile
}

function facetValue(v: unknown): string | null {
  if (v == null) return null
  if (typeof v === 'string') return v.trim() || null
  if (Array.isArray(v)) {
    const items = v
      .map((x) =>
        typeof x === 'string'
          ? x
          : x && typeof x === 'object'
            ? String((x as Record<string, unknown>).pattern ?? (x as Record<string, unknown>).name ?? (x as Record<string, unknown>).label ?? '')
            : String(x),
      )
      .filter(Boolean)
    return items.length ? items.slice(0, 6).join(' · ') : null
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (Array.isArray(o.adjectives)) return (o.adjectives as unknown[]).slice(0, 6).join(' · ')
    const vals = Object.values(o).filter((x) => typeof x === 'string') as string[]
    return vals.length ? vals.slice(0, 4).join(' · ') : null
  }
  return String(v)
}

const humanize = (k: string) => k.replace(/[-_]/g, ' ').replace(/^\w/, (c) => c.toUpperCase())

function extractFacets(profile: Record<string, unknown> | null): { label: string; value: string }[] {
  const style = asStyle(profile)
  const out: { label: string; value: string }[] = []
  for (const [key, label] of Object.entries(FACET_LABELS)) {
    if (key in style) {
      const v = facetValue(style[key])
      if (v) out.push({ label, value: v })
    }
  }
  // Fallback: surface whatever string/array fields exist if none of the known keys matched.
  if (out.length === 0) {
    for (const [k, v] of Object.entries(style)) {
      const val = facetValue(v)
      if (val) out.push({ label: humanize(k), value: val })
      if (out.length >= 6) break
    }
  }
  return out.slice(0, 8)
}
