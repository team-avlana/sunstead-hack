/**
 * Render a Postgres-backed project onto the tldraw canvas.
 *
 * The canvas is an artifact *renderer* (docs/architecture.md): it pulls the
 * project's artifacts from the python-service read API and maps each to a
 * tldraw shape. type='video' artifacts become Video Blocks (driven by the live
 * view-model the API joins from the videos table); other types render as text
 * cards. On a websocket change-signal we re-pull and reconcile.
 *
 * Backend shapes are id-namespaced (`shape:art-<artifactId>`) so reconciliation
 * never touches user-created shapes, and re-syncs preserve the position/zoom the
 * user set — only content (and height on a status change) is patched.
 */

import { createShapeId, type Editor, type TLShapeId } from 'tldraw'
import { RAINY_TEXT } from '@/components/RainyTextShape'
import { VIDEO_BLOCK, dims, type VideoData } from '@/components/VideoBlockShape'
import {
  fetchProjectState,
  resolveAssetUrl,
  type EnrichedArtifact,
  type ProjectState,
} from './api'
import { useRainyStore } from './store'

const artId = (artifactId: string): TLShapeId => createShapeId(`art-${artifactId}`)
const isBackendShape = (id: string) => id.startsWith('shape:art-')

type View = 'compact' | 'expanded' | 'full'

interface ShapeDesc {
  id: TLShapeId
  type: string
  x: number
  y: number
  props: Record<string, unknown>
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Pull frame URLs through resolveAssetUrl so `/frames/...` becomes absolute. */
function resolveVideoAssets(v: VideoData): VideoData {
  return {
    ...v,
    thumbnail: resolveAssetUrl(v.thumbnail) ?? v.thumbnail ?? null,
    storyboard: (v.storyboard ?? []).map((sc) => ({
      ...sc,
      thumbnail: resolveAssetUrl(sc.thumbnail) ?? sc.thumbnail ?? null,
    })),
  }
}

function videoDataFor(a: EnrichedArtifact): VideoData {
  const v: VideoData = resolveVideoAssets(a.video ?? { status: 'empty' })
  const payload = (a.payload ?? {}) as Record<string, unknown>
  if (!v.title) v.title = (payload.title as string) ?? a.title ?? null
  if (!v.source_url) v.source_url = (payload.source_url as string) ?? null
  return v
}

/** A non-video artifact rendered as a readable text card. */
function textHtmlFor(a: EnrichedArtifact): string {
  const payload = (a.payload ?? {}) as Record<string, unknown>
  const head = `<h2>${escapeHtml(a.title || a.type)}</h2>`
  const els = payload.elements
  if (Array.isArray(els) && els.length) {
    const items = els
      .map((e) => {
        const o = e as Record<string, unknown>
        const label = (o.label ?? o.text ?? o.title ?? JSON.stringify(o)) as string
        return `<li>${escapeHtml(String(label))}</li>`
      })
      .join('')
    return `${head}<ul>${items}</ul>`
  }
  if (typeof payload.text === 'string') return `${head}<p>${escapeHtml(payload.text)}</p>`
  if (typeof payload.body === 'string') return `${head}<p>${escapeHtml(payload.body)}</p>`
  return `${head}<p><em>${escapeHtml(a.type)} artifact</em></p>`
}

function mapArtifact(a: EnrichedArtifact, index: number): ShapeDesc {
  // Auto-grid for artifacts that carry no explicit position.
  const pos = a.position ?? {}
  const col = index % 3
  const row = Math.floor(index / 3)
  const x = typeof pos.x === 'number' ? pos.x : 80 + col * 420
  const y = typeof pos.y === 'number' ? pos.y : 80 + row * 380

  if (a.type === 'video') {
    const data = videoDataFor(a)
    const payload = (a.payload ?? {}) as Record<string, unknown>
    const view = ((payload.view as View) || (data.status === 'analysed' ? 'expanded' : 'compact')) as View
    const size = dims(view, data)
    return { id: artId(a.artifact_id), type: VIDEO_BLOCK, x, y, props: { ...size, view, data: JSON.stringify(data) } }
  }

  const w = typeof pos.w === 'number' ? pos.w : 440
  const h = typeof pos.h === 'number' ? pos.h : 260
  return { id: artId(a.artifact_id), type: RAINY_TEXT, x, y, props: { w, h, html: textHtmlFor(a) } }
}

/** Initial load: replace all backend shapes with the project's artifacts. Returns
 * false if there's no backend project to load (caller falls back to local XML). */
export async function loadBackendProject(editor: Editor, projectId: string): Promise<boolean> {
  const state = await fetchProjectState(projectId)
  if (!state) return false
  if (editor.isDisposed) return true

  useRainyStore.getState().setTitle(state.project.name)
  const descs = state.artifacts.map(mapArtifact)

  editor.store.mergeRemoteChanges(() => {
    editor.run(
      () => {
        const stale = editor.getCurrentPageShapes().filter((sh) => isBackendShape(sh.id)).map((sh) => sh.id)
        if (stale.length) editor.deleteShapes(stale)
        for (const d of descs) {
          try {
            editor.createShape(d as any)
          } catch {
            /* skip shapes that fail validation */
          }
        }
      },
      { history: 'ignore' },
    )
  })

  if (descs.length) {
    try {
      editor.zoomToFit()
    } catch {
      /* no-op */
    }
  }
  return true
}

/** Re-pull + reconcile (used on a websocket signal or the poll fallback). Preserves
 * user-set position/zoom; only patches content, and height when status changes. */
export async function syncBackendProject(editor: Editor, projectId: string): Promise<void> {
  const state: ProjectState | null = await fetchProjectState(projectId)
  if (!state || editor.isDisposed) return
  const descs = state.artifacts.map(mapArtifact)
  const desiredIds = new Set(descs.map((d) => d.id))

  editor.store.mergeRemoteChanges(() => {
    editor.run(
      () => {
        const existing = new Map(
          editor
            .getCurrentPageShapes()
            .filter((sh) => isBackendShape(sh.id))
            .map((sh) => [sh.id, sh] as const),
        )

        for (const d of descs) {
          const cur = existing.get(d.id)
          if (!cur) {
            try {
              editor.createShape(d as any)
            } catch {
              /* skip */
            }
            continue
          }
          // Patch content in place; keep the user's x/y + chosen disclosure level,
          // but always refit w/h to that view + the latest content so growth (e.g.
          // a storyboard arriving) never clips.
          if (d.type === VIDEO_BLOCK) {
            const view = ((cur as any).props?.view as View) || 'compact'
            const size = dims(view, JSON.parse(d.props.data as string))
            editor.updateShape({
              id: d.id,
              type: VIDEO_BLOCK,
              props: { data: d.props.data, w: size.w, h: size.h },
            } as any)
          } else if (d.type === RAINY_TEXT) {
            editor.updateShape({ id: d.id, type: RAINY_TEXT, props: { html: d.props.html } } as any)
          }
        }

        // Remove backend shapes whose artifact no longer exists.
        for (const [id] of existing) {
          if (!desiredIds.has(id)) editor.deleteShapes([id])
        }
      },
      { history: 'ignore' },
    )
  })
}
