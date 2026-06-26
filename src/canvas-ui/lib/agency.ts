/**
 * API client for the agency UGC dashboard (app/agency).
 *
 * A separate operational surface from the canvas: a roster of UGC creators, each
 * with a queue of deliveries reviewed against a brief/reference, producing a
 * verdict + per-dimension scores + a Slack-ready coaching note. Talks to the
 * python-service /api/agency/* routes. Falls back to empty/null with no backend.
 */

import { apiBase, resolveAssetUrl } from '@/lib/api'
import type { VideoData } from '@/lib/blockTypes'

export type Verdict = 'approve' | 'revise' | 'reshoot'
export type ReviewStatus = 'analyzing' | 'ready' | 'failed'
export type VideoStatus = 'analysing' | 'analysed' | 'error'

/** The score dimensions tracked for the trend (must match db.TREND_DIMENSIONS). */
export const TREND_DIMENSIONS = ['hook', 'tone', 'pacing', 'reference'] as const
export type Dimension = (typeof TREND_DIMENSIONS)[number]

export interface Scores {
  hook?: number
  tone?: number
  pacing?: number
  reference?: number
  constraints?: number
  [k: string]: number | undefined
}

export interface RosterRow {
  creator_id: string
  name: string
  kind: 'self' | 'reference' | 'talent'
  platform: string | null
  delivery_count: number
  pending_count: number
  last_activity: string | null
  latest_verdict: Verdict | null
  latest_overall: number | null
  latest_scores: Scores | null
  trend: Record<'hook' | 'tone' | 'pacing' | 'reference' | 'overall', number[]>
}

export interface VideoDisplay {
  video_id: string
  title: string | null
  source_url: string
  duration_sec: number | null
  status: VideoStatus
  analysis_stage: string | null
  analysis_error: string | null
  thumbnail: string | null
}

export interface ReviewListItem {
  review_id: string
  brief_title: string | null
  status: ReviewStatus
  verdict: Verdict | null
  overall_score: number | null
  scores: Scores | null
  note: string | null
  created_at: string
  delivery: VideoDisplay | null
}

export interface ReviewDimension {
  key: string
  label: string
  score: number
  comment: string
}

export interface Review {
  review_id: string
  creator_id: string
  delivery_video_id: string
  reference_video_id: string | null
  brief_title: string | null
  brief: string | null
  status: ReviewStatus
  verdict: Verdict | null
  overall_score: number | null
  scores: Scores | null
  dimensions: ReviewDimension[] | null
  strengths: string[] | null
  missing: string[] | null
  note: string | null
  error: string | null
  created_at: string
  updated_at: string
}

export interface Creator {
  creator_id: string
  kind: 'self' | 'reference' | 'talent'
  name: string
  platform: string | null
  channel_url: string | null
  created_at: string
}

export interface CreatorDetail {
  creator: Creator
  reviews: ReviewListItem[]
}

export interface ReviewFull {
  review: Review
  delivery: VideoData | null
  reference: VideoData | null
  creator: Creator | null
}

// ── thin transport ────────────────────────────────────────────────────────────

async function get<T>(path: string): Promise<T | null> {
  const base = apiBase()
  if (!base) return null
  try {
    const res = await fetch(`${base}${path}`, { cache: 'no-store' })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

async function send<T>(method: string, path: string, body?: unknown): Promise<T | null> {
  const base = apiBase()
  if (!base) return null
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    })
    if (!res.ok) return null
    try {
      return (await res.json()) as T
    } catch {
      return {} as T
    }
  } catch {
    return null
  }
}

function resolveVideo(v: VideoData | null): VideoData | null {
  if (!v) return null
  return {
    ...v,
    thumbnail: resolveAssetUrl(v.thumbnail) ?? v.thumbnail ?? null,
    storyboard: (v.storyboard ?? []).map((sc) => ({
      ...sc,
      thumbnail: resolveAssetUrl(sc.thumbnail) ?? sc.thumbnail ?? null,
    })),
  }
}

function resolveDisplay(d: VideoDisplay | null): VideoDisplay | null {
  if (!d) return null
  return { ...d, thumbnail: resolveAssetUrl(d.thumbnail) ?? d.thumbnail ?? null }
}

// ── endpoints ──────────────────────────────────────────────────────────────────

export async function fetchRoster(): Promise<RosterRow[]> {
  const data = await get<{ roster: RosterRow[] }>('/api/agency/roster')
  return data?.roster ?? []
}

export async function addCreator(name: string, platform?: string): Promise<{ creator_id: string } | null> {
  return send('POST', '/api/agency/creators', { name, platform: platform ?? null })
}

export async function fetchCreatorDetail(creatorId: string): Promise<CreatorDetail | null> {
  const data = await get<CreatorDetail>(`/api/agency/creators/${encodeURIComponent(creatorId)}`)
  if (!data) return null
  return { ...data, reviews: data.reviews.map((r) => ({ ...r, delivery: resolveDisplay(r.delivery) })) }
}

export interface NewDelivery {
  creator_id?: string
  creator_name?: string
  source_url?: string
  file_name?: string
  file_data?: string // base64 / data-url
  brief_title?: string
  brief?: string
  reference_url?: string
}

export async function createDelivery(
  body: NewDelivery,
): Promise<{ review_id: string; video_id: string; creator_id: string } | null> {
  return send('POST', '/api/agency/deliveries', body)
}

export async function fetchReview(reviewId: string): Promise<ReviewFull | null> {
  const data = await get<ReviewFull>(`/api/agency/reviews/${encodeURIComponent(reviewId)}`)
  if (!data) return null
  return { ...data, delivery: resolveVideo(data.delivery), reference: resolveVideo(data.reference) }
}

export async function runReview(reviewId: string): Promise<boolean> {
  const res = await send<{ status: string }>('POST', `/api/agency/reviews/${encodeURIComponent(reviewId)}/run`)
  return res?.status === 'analyzing'
}

export async function deleteReview(reviewId: string): Promise<boolean> {
  const res = await send<{ ok: boolean }>('DELETE', `/api/agency/reviews/${encodeURIComponent(reviewId)}`)
  return !!res?.ok
}

/** Read a File as a base64 data-url for the dependency-free upload path. */
export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

// ── display helpers ──────────────────────────────────────────────────────────

export const VERDICT_LABEL: Record<Verdict, string> = {
  approve: 'Approve',
  revise: 'Revise',
  reshoot: 'Reshoot',
}

export const DIMENSION_LABEL: Record<string, string> = {
  hook: 'Hook',
  tone: 'Tone',
  pacing: 'Pacing',
  reference: 'Reference',
  constraints: 'Constraints',
}

export function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  } catch {
    return '—'
  }
}

export function fmtDuration(sec: number | null | undefined): string {
  if (!sec || sec <= 0) return ''
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}
