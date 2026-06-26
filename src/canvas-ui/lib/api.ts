/**
 * API client for the python-service (the canvas is a static export and
 * cannot open Postgres directly — see docs/INTEGRATION_NOTES.md #4).
 *
 * Base URL comes from NEXT_PUBLIC_RAINY_API_URL (e.g. http://localhost:9000).
 * When unset, every call resolves empty/null so the canvas falls back to its
 * local XML/localStorage projects and runs with no backend at all.
 */

import type { VideoData } from '@/lib/blockTypes'

export interface BackendProject {
  project_id: string
  name: string
  created_at: string
}

export interface EnrichedArtifact {
  artifact_id: string
  project_id: string
  type: string
  title: string | null
  /** For a 'frame': { label, role?, elements:[{id, type, x, y, w, h, ...}] }. */
  payload: Record<string, unknown> | null
  position: { x?: number; y?: number; w?: number; h?: number } | null
  z: number
  version: number
  /** Legacy standalone 'video' artifact: the live view-model from the videos table. */
  video?: VideoData
}

export interface ProjectState {
  project: BackendProject
  artifacts: EnrichedArtifact[]
}

export interface ArtifactPatch {
  /** Replace the whole payload. */
  payload?: Record<string, unknown>
  /** Shallow-merge these keys into the existing payload (e.g. {content}, {label}, {view}). */
  payload_patch?: Record<string, unknown>
  /** Merge a patch into the payload element with this id. */
  element_id?: string
  element_patch?: Record<string, unknown>
  /** Remove the payload element with this id (a child block deleted on the canvas). */
  element_remove?: string
  position?: { x?: number; y?: number; w?: number; h?: number }
  title?: string
}

export interface NewArtifact {
  type: string
  title?: string | null
  payload?: Record<string, unknown>
  position?: { x?: number; y?: number; w?: number; h?: number }
}

export interface VideoStatus {
  video_id: string
  status: 'analysing' | 'analysed' | 'error'
  title: string | null
  duration_sec: number | null
  analyzed_at: string | null
  analysis_error: string | null
}

export interface CreatorVideoItem {
  video_id: string
  status: 'analysing' | 'analysed' | 'error'
  title: string | null
  source_url: string
  duration_sec: number | null
  thumbnail: string | null
}

export interface CreatorVideoList {
  creator_id: string
  videos: CreatorVideoItem[]
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Backend project ids are UUIDs; local seeds use slugs / `p-…` ids. */
export const isBackendId = (id: string) => UUID_RE.test(id)

export function apiBase(): string | null {
  const b = process.env.NEXT_PUBLIC_RAINY_API_URL
  return b ? b.replace(/\/+$/, '') : null
}

export function wsBase(): string | null {
  const b = apiBase()
  return b ? b.replace(/^http/, 'ws') : null
}

export function hasBackend(): boolean {
  return apiBase() != null
}

/**
 * Discriminated request outcome so callers can distinguish a real transport
 * failure (retry) from a definitive HTTP status (e.g. 404 = already gone) from a
 * "no backend configured" no-op. The thin getJson/mutateJson wrappers below
 * collapse this back to `T | null` for callers that don't care, but the sync
 * layer (backendSync / backendCanvas) branches on it to retry, suppress
 * resurrection, and surface offline/not-found states. See INTEGRATION_NOTES.
 */
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: 'http'; status: number }
  | { ok: false; kind: 'network' }
  | { ok: false; kind: 'no-backend' }

/** True for a 4xx other than 429 — a definitive client error that won't change
 * on retry (404 gone / 409 conflict / 410 deleted). 429 + 5xx are transient. */
export function isTerminalHttp(r: ApiResult<unknown>): boolean {
  return r.ok === false && r.kind === 'http' && r.status >= 400 && r.status < 500 && r.status !== 429
}

async function request<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
  const base = apiBase()
  if (!base) return { ok: false, kind: 'no-backend' }
  let res: Response
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    })
  } catch {
    return { ok: false, kind: 'network' } // offline / DNS / connection refused / CORS
  }
  if (!res.ok) return { ok: false, kind: 'http', status: res.status }
  // Some mutations (DELETE/restore) may return an empty body; tolerate it.
  try {
    return { ok: true, data: (await res.json()) as T }
  } catch {
    return { ok: true, data: {} as T }
  }
}

async function getJson<T>(path: string): Promise<T | null> {
  const r = await request<T>('GET', path)
  return r.ok ? r.data : null
}

async function mutateJson<T>(method: string, path: string, body?: unknown): Promise<T | null> {
  const r = await request<T>(method, path, body)
  return r.ok ? r.data : null
}

/**
 * Tell the backend which project the canvas currently has open, so the embedded
 * Claude session and its MCP tools can default to it (see
 * python-service/active_project.py). Pass null when returning to Home / nothing
 * is open. No-op when no backend is configured.
 */
export async function setActiveProject(
  projectId: string | null,
  name?: string | null,
): Promise<void> {
  await mutateJson('PUT', '/api/active-project', { project_id: projectId, name: name ?? null })
}

export async function fetchProjects(): Promise<BackendProject[]> {
  const data = await getJson<{ projects: BackendProject[] }>('/api/projects')
  return data?.projects ?? []
}

export async function fetchProjectState(projectId: string): Promise<ProjectState | null> {
  return getJson<ProjectState>(`/api/projects/${encodeURIComponent(projectId)}`)
}

/** Project load outcome the canvas can branch on: render, "doesn't exist"
 * (don't keep retrying / offer Home), or "can't reach the service" (retry). */
export type ProjectLoad =
  | { kind: 'ok'; state: ProjectState }
  | { kind: 'notfound' }
  | { kind: 'unreachable' }
  | { kind: 'no-backend' }

export async function fetchProjectStateResult(projectId: string): Promise<ProjectLoad> {
  const r = await request<ProjectState>('GET', `/api/projects/${encodeURIComponent(projectId)}`)
  if (r.ok) return { kind: 'ok', state: r.data }
  if (r.kind === 'no-backend') return { kind: 'no-backend' }
  if (r.kind === 'http' && r.status === 404) return { kind: 'notfound' }
  return { kind: 'unreachable' } // network, 5xx, or other transient
}

export async function fetchArtifact(artifactId: string): Promise<EnrichedArtifact | null> {
  const data = await getJson<{ artifact: EnrichedArtifact }>(
    `/api/artifacts/${encodeURIComponent(artifactId)}`,
  )
  return data?.artifact ?? null
}

/** A client-generated artifact id (UUID) the canvas can register up-front, so a
 * create that has to be retried (lost response / transient backend) is
 * idempotent — the backend upserts on this id instead of inserting a duplicate. */
export type CreateArtifactBody = NewArtifact & { client_id?: string }

export async function createArtifactResult(
  projectId: string,
  artifact: CreateArtifactBody,
): Promise<ApiResult<{ artifact_id: string; version: number }>> {
  return request('POST', `/api/projects/${encodeURIComponent(projectId)}/artifacts`, artifact)
}

export async function updateArtifactResult(
  artifactId: string,
  patch: ArtifactPatch,
): Promise<ApiResult<{ artifact_id: string; version: number }>> {
  return request('PUT', `/api/artifacts/${encodeURIComponent(artifactId)}`, patch)
}

export async function deleteArtifactResult(artifactId: string): Promise<ApiResult<{ ok: boolean }>> {
  return request('DELETE', `/api/artifacts/${encodeURIComponent(artifactId)}`)
}

/** Undo of a delete: clear the soft-delete (deleted_at) so the SAME artifact id
 * comes back — no id drift, no duplicate. Idempotent server-side. */
export async function restoreArtifactResult(artifactId: string): Promise<ApiResult<{ artifact_id: string }>> {
  return request('POST', `/api/artifacts/${encodeURIComponent(artifactId)}/restore`)
}

// Back-compat T|null wrappers (used by tidyFrame + any non-retrying callers).
export async function createArtifact(
  projectId: string,
  artifact: CreateArtifactBody,
): Promise<{ artifact_id: string; version: number } | null> {
  const r = await createArtifactResult(projectId, artifact)
  return r.ok ? r.data : null
}

export async function updateArtifact(
  artifactId: string,
  patch: ArtifactPatch,
): Promise<{ artifact_id: string; version: number } | null> {
  const r = await updateArtifactResult(artifactId, patch)
  return r.ok ? r.data : null
}

export async function deleteArtifact(artifactId: string): Promise<{ ok: boolean } | null> {
  const r = await deleteArtifactResult(artifactId)
  return r.ok ? r.data : null
}

export async function fetchVideoStatus(videoId: string): Promise<VideoStatus | null> {
  return getJson<VideoStatus>(`/api/videos/${encodeURIComponent(videoId)}/status`)
}

/**
 * Start analysis for a video URL — the canvas equivalent of the analyze_video MCP
 * tool (POST /api/analyze). The python-service inserts a videos row, spawns the
 * analysis-worker, and returns the new video_id; the caller then polls
 * fetchVideoView until status flips to analysed/error. Without a creator_id, a
 * singleton "Canvas" creator owns the video. Returns null when no backend is set.
 */
export async function triggerAnalysis(
  sourceUrl: string,
  creatorId?: string,
): Promise<{ video_id: string; creator_id: string } | null> {
  return mutateJson('POST', '/api/analyze', { source_url: sourceUrl, creator_id: creatorId ?? null })
}

/** Re-run analysis for an existing video (the Video Block "Retry" action). */
export async function reanalyzeVideo(videoId: string): Promise<boolean> {
  const res = await mutateJson<{ video_id: string }>(
    'POST',
    `/api/videos/${encodeURIComponent(videoId)}/reanalyze`,
  )
  return !!res?.video_id
}

/**
 * Fetch the live Video Block view-model for a video (GET /api/videos/{id}),
 * with `/frames/...` thumbnails resolved to absolute URLs so an <img> in the
 * block can load them directly. Used by the local analysis poll loop.
 */
export async function fetchVideoView(videoId: string): Promise<VideoData | null> {
  const data = await getJson<{ video: VideoData }>(`/api/videos/${encodeURIComponent(videoId)}`)
  const v = data?.video
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

export async function fetchCreatorVideos(creatorId: string): Promise<CreatorVideoList | null> {
  return getJson<CreatorVideoList>(`/api/creators/${encodeURIComponent(creatorId)}/videos`)
}

/** Resolve a frame/thumbnail URL returned by the API (relative `/frames/...`) to absolute. */
export function resolveAssetUrl(url: string | null | undefined): string | null {
  if (!url) return null
  if (/^https?:\/\//.test(url) || url.startsWith('data:')) return url
  const base = apiBase()
  return base ? `${base}${url.startsWith('/') ? '' : '/'}${url}` : url
}

// ───────────────────────────────────────────────────────────────────────────
// Creators — the user's own channel ('self') + reference channels.
// ───────────────────────────────────────────────────────────────────────────

export interface Creator {
  creator_id: string
  kind: 'self' | 'reference'
  name: string
  platform: string | null
  channel_url: string | null
  created_at: string
}

/** The single 'self' creator (the user), created on first access, plus cheap
 *  status flags so the home screen can show room/profile/analysis state. */
export interface SelfCreator {
  creator_id: string
  kind: 'self'
  name: string
  channel_url: string | null
  has_room_image: boolean
  style_profile_at: string | null
  video_count: number
  analyzed_count: number
}

export async function fetchCreators(kind?: 'self' | 'reference'): Promise<Creator[]> {
  const data = await getJson<{ creators: Creator[] }>(`/api/creators${kind ? `?kind=${kind}` : ''}`)
  return data?.creators ?? []
}

export async function fetchSelfCreator(): Promise<SelfCreator | null> {
  return getJson<SelfCreator>('/api/creators/self')
}

// ───────────────────────────────────────────────────────────────────────────
// Creator Room image — generated by the python-service from the wizard brief +
// the creator's real talking-head frames (see image_gen.generate).
// ───────────────────────────────────────────────────────────────────────────

/** Absolute URL of a creator's stored room image. `bust` cache-busts after a
 *  fresh generation so the <img> re-fetches. Null when no backend is configured. */
export function roomImageUrl(creatorId: string, bust?: string | number): string | null {
  const base = apiBase()
  if (!base) return null
  const q = bust != null ? `?t=${encodeURIComponent(String(bust))}` : ''
  return `${base}/api/creators/${encodeURIComponent(creatorId)}/room-image${q}`
}

/** Generate (and persist) a creator's room image. `prompt` is the wizard's
 *  fully-built prompt (used verbatim); `avatarPhoto` is a data: URL of the
 *  uploaded face. Resolves once the PNG is saved; fetch it via roomImageUrl. */
export async function generateRoomImage(
  creatorId: string,
  opts: { prompt?: string; profile?: Record<string, unknown>; avatarPhoto?: string } = {},
): Promise<{ creator_id: string; image_url: string } | null> {
  return mutateJson('POST', `/api/creators/${encodeURIComponent(creatorId)}/room-image`, {
    prompt: opts.prompt ?? null,
    profile: opts.profile ?? null,
    avatar_photo: opts.avatarPhoto ?? null,
  })
}

// ───────────────────────────────────────────────────────────────────────────
// Style profile — aggregated content DNA for a creator (build is async).
// ───────────────────────────────────────────────────────────────────────────

export interface StyleProfile {
  summary: string | null
  // Structured aggregates (hook_patterns, pacing_style, visual_style, voice_tone, …).
  profile: Record<string, unknown> | null
  created_at: string
}

export async function fetchStyleProfile(creatorId: string): Promise<StyleProfile | null> {
  return getJson<StyleProfile>(`/api/creators/${encodeURIComponent(creatorId)}/style-profile`)
}

/** Kick off background aggregation. Poll fetchStyleProfile and watch created_at
 *  advance to detect completion. Returns true when the build was accepted. */
export async function buildStyleProfile(creatorId: string): Promise<boolean> {
  const res = await mutateJson<{ status: string }>(
    'POST',
    `/api/creators/${encodeURIComponent(creatorId)}/style-profile`,
  )
  return res?.status === 'started'
}

// ───────────────────────────────────────────────────────────────────────────
// Channel analysis — enumerate + analyse a whole channel; poll progress.
// ───────────────────────────────────────────────────────────────────────────

export interface ChannelAnalysis {
  creator_id: string
  videos: { video_id: string; status: 'running' | 'done' | 'failed' }[]
  done: number
  total: number
}

export async function analyzeChannel(
  channelUrl: string,
  kind: 'self' | 'reference',
  name?: string,
  maxVideos?: number,
): Promise<{ creator_id: string; video_ids: string[] } | null> {
  return mutateJson('POST', '/api/analyze-channel', {
    channel_url: channelUrl,
    kind,
    name: name ?? null,
    max_videos: maxVideos ?? null,
  })
}

export async function fetchChannelAnalysis(creatorId: string): Promise<ChannelAnalysis | null> {
  return getJson<ChannelAnalysis>(`/api/creators/${encodeURIComponent(creatorId)}/channel-analysis`)
}

// ───────────────────────────────────────────────────────────────────────────
// Memory — goals / audience / constraints / preferences / notes the agent reads.
// ───────────────────────────────────────────────────────────────────────────

export type MemoryKind = 'goal' | 'audience' | 'platform' | 'constraint' | 'preference' | 'note'

export interface MemoryEntry {
  memory_id: string
  project_id: string | null // null = user-level (spans projects)
  kind: MemoryKind
  key: string | null
  value: string
  data: unknown
  created_at: string
}

/** User-level memory always; with a backend projectId, also that project's. */
export async function fetchMemory(projectId?: string | null, kind?: MemoryKind): Promise<MemoryEntry[]> {
  const params = new URLSearchParams()
  if (projectId) params.set('project_id', projectId)
  if (kind) params.set('kind', kind)
  const qs = params.toString()
  const data = await getJson<{ memory: MemoryEntry[] }>(`/api/memory${qs ? `?${qs}` : ''}`)
  return data?.memory ?? []
}

export async function createMemory(entry: {
  kind: MemoryKind
  value: string
  key?: string | null
  project_id?: string | null
}): Promise<{ memory_id: string } | null> {
  return mutateJson('POST', '/api/memory', {
    kind: entry.kind,
    value: entry.value,
    key: entry.key ?? null,
    project_id: entry.project_id ?? null,
  })
}

export async function deleteMemory(memoryId: string): Promise<boolean> {
  const res = await mutateJson<{ ok: boolean }>('DELETE', `/api/memory/${encodeURIComponent(memoryId)}`)
  return !!res?.ok
}

// ───────────────────────────────────────────────────────────────────────────
// Shots — the full per-shot breakdown behind a video block (deep dive).
// ───────────────────────────────────────────────────────────────────────────

export interface ShotItem {
  idx: number
  start_sec: number
  end_sec: number
  frame_id: string | null
  frame_url: string | null
  analysis: { deterministic?: Record<string, unknown>; llm?: Record<string, unknown> } | null
}

/** A headline video-level metric from videos.metrics (grouped for display). */
export interface MetricItem {
  group: string
  label: string
  value: string
}

export interface VideoShots {
  video_id: string
  shot_count: number
  shots: ShotItem[]
  video: VideoData
  /** Pacing / speech / visual / narrative headline metrics (videos.metrics). */
  metrics: MetricItem[]
}

/** Full shot list with per-shot analysis; frame URLs resolved to absolute. */
export async function fetchVideoShots(videoId: string): Promise<VideoShots | null> {
  const data = await getJson<VideoShots>(`/api/videos/${encodeURIComponent(videoId)}/shots`)
  if (!data) return null
  return {
    ...data,
    shots: data.shots.map((s) => ({ ...s, frame_url: resolveAssetUrl(s.frame_url) ?? s.frame_url })),
  }
}
