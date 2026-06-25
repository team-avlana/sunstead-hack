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

async function getJson<T>(path: string): Promise<T | null> {
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

async function mutateJson<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T | null> {
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
    return (await res.json()) as T
  } catch {
    return null
  }
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

export async function fetchArtifact(artifactId: string): Promise<EnrichedArtifact | null> {
  const data = await getJson<{ artifact: EnrichedArtifact }>(
    `/api/artifacts/${encodeURIComponent(artifactId)}`,
  )
  return data?.artifact ?? null
}

export async function createArtifact(
  projectId: string,
  artifact: NewArtifact,
): Promise<{ artifact_id: string; version: number } | null> {
  return mutateJson('POST', `/api/projects/${encodeURIComponent(projectId)}/artifacts`, artifact)
}

export async function updateArtifact(
  artifactId: string,
  patch: ArtifactPatch,
): Promise<{ artifact_id: string; version: number } | null> {
  return mutateJson('PUT', `/api/artifacts/${encodeURIComponent(artifactId)}`, patch)
}

export async function deleteArtifact(artifactId: string): Promise<{ ok: boolean } | null> {
  return mutateJson('DELETE', `/api/artifacts/${encodeURIComponent(artifactId)}`)
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
