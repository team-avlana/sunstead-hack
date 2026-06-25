/**
 * Read API client for the python-service (the canvas is a static export and
 * cannot open Postgres directly — see docs/INTEGRATION_NOTES.md #4).
 *
 * Base URL comes from NEXT_PUBLIC_RAINY_API_URL (e.g. http://localhost:9000).
 * When unset, every call resolves empty/null so the canvas falls back to its
 * local XML/localStorage projects and runs with no backend at all.
 */

import type { VideoData } from '@/components/VideoBlockShape'

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

/** Resolve a frame/thumbnail URL returned by the API (relative `/frames/...`) to absolute. */
export function resolveAssetUrl(url: string | null | undefined): string | null {
  if (!url) return null
  if (/^https?:\/\//.test(url) || url.startsWith('data:')) return url
  const base = apiBase()
  return base ? `${base}${url.startsWith('/') ? '' : '/'}${url}` : url
}
