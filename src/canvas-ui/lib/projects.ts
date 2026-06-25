/**
 * Local-first project library.
 *
 * A project IS its canvas: title + the blocks on the infinite canvas, serialized
 * to a single, human-editable **XML file**. That makes mocking projects trivial —
 * drop an `.xml` in `public/projects/` and list it in `index.json`. At runtime,
 * user-created/edited projects are persisted to `localStorage` (the static export
 * has no server), while the shipped seeds load from disk as starting points.
 *
 * Canonical truth in production is Postgres (see docs/architecture.md); this XML
 * layer is the local stand-in so the canvas works end-to-end with no backend.
 */

import { fetchProjects, hasBackend } from './api'

/** One block on the canvas. `props` is shape-type specific (rainy-text: w/h/html). */
export interface RainyShape {
  id: string
  type: string
  x: number
  y: number
  props: Record<string, string | number | boolean>
}

/** A project = its title + the blocks on its canvas. */
export interface Project {
  id: string
  title: string
  /** ISO timestamp of last edit. */
  updated: string
  shapes: RainyShape[]
}

/** Lightweight project entry for the Home grid (no shape payload). */
export interface ProjectMeta {
  id: string
  title: string
  updated: string
  blocks: number
  origin: 'seed' | 'local' | 'backend'
}

const SEED_MANIFEST = '/projects/index.json'
const seedXmlPath = (id: string) => `/projects/${id}.xml`

const LS = {
  xml: (id: string) => `rainy:project:${id}`,
  index: 'rainy:index',
  hidden: 'rainy:hidden',
}

const ls = (): Storage | null => (typeof window !== 'undefined' ? window.localStorage : null)
const nowIso = () => new Date().toISOString()

export function createProjectId(): string {
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

// ---------------------------------------------------------------------------
// XML  <->  Project
// ---------------------------------------------------------------------------

const escapeAttr = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

// Wrap arbitrary text (e.g. tiptap HTML) in CDATA, splitting any literal ']]>'.
const cdata = (s: string) => `<![CDATA[${s.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`

/** Serialize a project to its canonical XML document. */
export function serializeProjectXml(p: Project): string {
  const out: string[] = []
  out.push('<?xml version="1.0" encoding="UTF-8"?>')
  out.push(`<project id="${escapeAttr(p.id)}" title="${escapeAttr(p.title)}" updated="${escapeAttr(p.updated)}">`)
  for (const sh of p.shapes) {
    out.push(`  <shape id="${escapeAttr(sh.id)}" type="${escapeAttr(sh.type)}" x="${sh.x}" y="${sh.y}">`)
    for (const [name, value] of Object.entries(sh.props)) {
      if (value == null) continue
      if (typeof value === 'number') {
        out.push(`    <prop name="${escapeAttr(name)}" type="number">${value}</prop>`)
      } else if (typeof value === 'boolean') {
        out.push(`    <prop name="${escapeAttr(name)}" type="boolean">${value}</prop>`)
      } else {
        out.push(`    <prop name="${escapeAttr(name)}">${cdata(value)}</prop>`)
      }
    }
    out.push('  </shape>')
  }
  out.push('</project>')
  return out.join('\n') + '\n'
}

/** Parse a project XML document. Throws on malformed XML. */
export function parseProjectXml(xml: string): Project {
  if (typeof window === 'undefined') throw new Error('parseProjectXml requires the browser DOMParser')
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.querySelector('parsererror')) throw new Error('Invalid project XML')

  const root = doc.documentElement
  const shapes: RainyShape[] = []
  root.querySelectorAll(':scope > shape').forEach((el) => {
    const props: RainyShape['props'] = {}
    el.querySelectorAll(':scope > prop').forEach((pe) => {
      const name = pe.getAttribute('name')
      if (!name) return
      const t = pe.getAttribute('type')
      const raw = pe.textContent ?? ''
      props[name] = t === 'number' ? Number(raw) : t === 'boolean' ? raw.trim() === 'true' : raw
    })
    shapes.push({
      id: el.getAttribute('id') || createProjectId(),
      type: el.getAttribute('type') || 'rainy-text',
      x: Number(el.getAttribute('x') || 0),
      y: Number(el.getAttribute('y') || 0),
      props,
    })
  })

  return {
    id: root.getAttribute('id') || createProjectId(),
    title: root.getAttribute('title') || 'Untitled project',
    updated: root.getAttribute('updated') || nowIso(),
    shapes,
  }
}

// ---------------------------------------------------------------------------
// Local index + hidden set (so the Home grid renders without reading every XML)
// ---------------------------------------------------------------------------

function readIndex(): Record<string, ProjectMeta> {
  try {
    return JSON.parse(ls()?.getItem(LS.index) || '{}')
  } catch {
    return {}
  }
}
function writeIndex(ix: Record<string, ProjectMeta>): void {
  ls()?.setItem(LS.index, JSON.stringify(ix))
}
function readHidden(): string[] {
  try {
    return JSON.parse(ls()?.getItem(LS.hidden) || '[]')
  } catch {
    return []
  }
}
function writeHidden(h: string[]): void {
  ls()?.setItem(LS.hidden, JSON.stringify(h))
}

async function fetchSeeds(): Promise<ProjectMeta[]> {
  try {
    const res = await fetch(SEED_MANIFEST, { cache: 'no-cache' })
    if (!res.ok) return []
    const json = (await res.json()) as { seeds?: Array<Omit<ProjectMeta, 'origin'>> }
    return (json.seeds || []).map((s) => ({ ...s, origin: 'seed' as const }))
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** All projects for the Home grid: shipped seeds ∪ local edits (local wins), newest first. */
export async function listProjects(): Promise<ProjectMeta[]> {
  const hidden = new Set(readHidden())
  const [seeds, backend] = await Promise.all([
    fetchSeeds(),
    hasBackend() ? fetchProjects() : Promise.resolve([]),
  ])
  const index = readIndex()

  const byId = new Map<string, ProjectMeta>()
  for (const s of seeds) if (!hidden.has(s.id)) byId.set(s.id, s)
  for (const m of Object.values(index)) if (!hidden.has(m.id)) byId.set(m.id, m) // local overrides seed
  for (const b of backend) {
    if (hidden.has(b.project_id)) continue
    byId.set(b.project_id, {
      id: b.project_id,
      title: b.name,
      updated: b.created_at,
      blocks: 0,
      origin: 'backend',
    })
  }

  return [...byId.values()].sort((a, b) => (b.updated || '').localeCompare(a.updated || ''))
}

/** Load a full project — local copy if it exists, otherwise the shipped seed XML. */
export async function loadProject(id: string): Promise<Project> {
  const local = ls()?.getItem(LS.xml(id))
  if (local) return parseProjectXml(local)

  const res = await fetch(seedXmlPath(id), { cache: 'no-cache' })
  if (!res.ok) throw new Error(`Project not found: ${id}`)
  return parseProjectXml(await res.text())
}

/** Persist a project (XML + index entry) to localStorage. */
export function saveProject(p: Project): void {
  ls()?.setItem(LS.xml(p.id), serializeProjectXml(p))
  const index = readIndex()
  index[p.id] = { id: p.id, title: p.title, updated: p.updated, blocks: p.shapes.length, origin: 'local' }
  writeIndex(index)
}

/** Create and persist a fresh, empty project. */
export function createProject(title = 'Untitled project'): Project {
  const project: Project = { id: createProjectId(), title, updated: nowIso(), shapes: [] }
  saveProject(project)
  return project
}

/** Rename a project (loads current content so the canvas is preserved). */
export async function updateProjectTitle(id: string, title: string): Promise<void> {
  const project = await loadProject(id)
  project.title = title
  project.updated = nowIso()
  saveProject(project)
}

/** Remove a project. Seeds are also added to a hidden set so they don't reappear. */
export function deleteProject(id: string): void {
  ls()?.removeItem(LS.xml(id))
  const index = readIndex()
  delete index[id]
  writeIndex(index)
  const hidden = readHidden()
  if (!hidden.includes(id)) {
    hidden.push(id)
    writeHidden(hidden)
  }
}
