/**
 * Render a Postgres-backed project onto the tldraw canvas.
 *
 * The canvas is an artifact *renderer* (docs/architecture.md): it pulls the
 * project's artifacts from the python-service read API and maps each to tldraw
 * shapes. Every artifact is a FRAME (a flow); the blocks it contains live inside
 * payload.elements and render as children of the frame:
 *   - element type='text'  → a markdown/rich text card (element.content).
 *   - element type='video' → a Video Block (driven by the live view-model the
 *     API joins from the videos table onto the element).
 * (Legacy standalone 'video'/'text' artifacts still render as a single shape.)
 * On a websocket change-signal we re-pull and reconcile.
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

/** tldraw's built-in frame shape — used as a flow container. */
const FRAME = 'frame' as const

type View = 'compact' | 'expanded' | 'full'

interface ShapeDesc {
  id: TLShapeId
  type: string
  x: number
  y: number
  props: Record<string, unknown>
  /** Containing frame's shape id (a block's flow); undefined = top-level. */
  parentId?: TLShapeId
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const looksLikeHtml = (s: string) => /<[a-z][\s\S]*>/i.test(s)

/** Frames must exist before their children, so create frames first. */
function orderForCreate(descs: ShapeDesc[]): ShapeDesc[] {
  return [...descs].sort((a, b) => (a.type === FRAME ? 0 : 1) - (b.type === FRAME ? 0 : 1))
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

/** Video Block props from a source that carries the enriched view-model under
 * `.video` (a video element, or a legacy standalone video artifact). */
function videoShapeProps(src: Record<string, unknown>): { view: View; data: string; w: number; h: number } {
  const data: VideoData = resolveVideoAssets((src.video as VideoData) ?? { status: 'empty' })
  if (!data.title) data.title = (src.title as string) ?? null
  if (!data.source_url) data.source_url = (src.source_url as string) ?? null
  const view = ((src.view as View) || (data.status === 'analysed' ? 'expanded' : 'compact')) as View
  const size = dims(view, data)
  return { view, data: JSON.stringify(data), w: size.w, h: size.h }
}

/** A text element's body — element.content is HTML or plain text. */
function elementTextHtml(el: Record<string, unknown>): string {
  const content = el.content
  if (typeof content === 'string' && content.trim()) {
    return looksLikeHtml(content) ? content : `<p>${escapeHtml(content)}</p>`
  }
  const label = (el.label ?? el.text ?? el.title) as string | undefined
  return label ? `<p>${escapeHtml(String(label))}</p>` : '<p><em>text</em></p>'
}

/** A text block's body. A `text` block carries payload.content (HTML or plain);
 * legacy/composite artifacts fall back to a titled list/card. */
function textHtmlFor(a: EnrichedArtifact): string {
  const payload = (a.payload ?? {}) as Record<string, unknown>
  if (typeof payload.content === 'string' && payload.content.trim()) {
    return looksLikeHtml(payload.content) ? payload.content : `<p>${escapeHtml(payload.content)}</p>`
  }
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

/** Expand one artifact into tldraw shapes. A 'frame' artifact yields the frame
 * plus a child shape per payload element; a legacy standalone video/text
 * artifact yields a single shape. */
function expandArtifact(a: EnrichedArtifact, index: number): ShapeDesc[] {
  // Auto-grid for frames that carry no explicit position (absolute page space).
  const pos = a.position ?? {}
  const col = index % 3
  const row = Math.floor(index / 3)
  const x = typeof pos.x === 'number' ? pos.x : 80 + col * 460
  const y = typeof pos.y === 'number' ? pos.y : 80 + row * 560

  if (a.type === FRAME) {
    const payload = (a.payload ?? {}) as Record<string, unknown>
    const w = typeof pos.w === 'number' ? pos.w : 760
    const h = typeof pos.h === 'number' ? pos.h : 560
    const name = (payload.label as string) || a.title || 'Flow'
    const frameId = artId(a.artifact_id)
    const shapes: ShapeDesc[] = [{ id: frameId, type: FRAME, x, y, props: { name, w, h } }]

    const els = Array.isArray(payload.elements) ? (payload.elements as Record<string, unknown>[]) : []
    els.forEach((el, i) => {
      // Stable per-element shape id; x/y are relative to the frame.
      const id = artId(`${a.artifact_id}::${String(el.id ?? `el-${i}`)}`)
      const ex = typeof el.x === 'number' ? el.x : 32 + (i % 2) * 360
      const ey = typeof el.y === 'number' ? el.y : 64 + Math.floor(i / 2) * 260
      if (el.type === 'video') {
        shapes.push({ id, type: VIDEO_BLOCK, x: ex, y: ey, parentId: frameId, props: videoShapeProps(el) })
      } else {
        const ew = typeof el.w === 'number' ? el.w : 320
        const eh = typeof el.h === 'number' ? el.h : 200
        shapes.push({ id, type: RAINY_TEXT, x: ex, y: ey, parentId: frameId, props: { w: ew, h: eh, html: elementTextHtml(el) } })
      }
    })
    return shapes
  }

  // Legacy standalone artifacts (no enclosing frame).
  if (a.type === 'video') {
    const payload = (a.payload ?? {}) as Record<string, unknown>
    return [{ id: artId(a.artifact_id), type: VIDEO_BLOCK, x, y, props: videoShapeProps({ ...payload, video: a.video, title: a.title }) }]
  }
  const w = typeof pos.w === 'number' ? pos.w : 440
  const h = typeof pos.h === 'number' ? pos.h : 260
  return [{ id: artId(a.artifact_id), type: RAINY_TEXT, x, y, props: { w, h, html: textHtmlFor(a) } }]
}

/** Initial load: replace all backend shapes with the project's artifacts. Returns
 * false if there's no backend project to load (caller falls back to local XML). */
export async function loadBackendProject(editor: Editor, projectId: string): Promise<boolean> {
  const state = await fetchProjectState(projectId)
  if (!state) return false
  if (editor.isDisposed) return true

  useRainyStore.getState().setTitle(state.project.name)
  const descs = state.artifacts.flatMap(expandArtifact)

  editor.store.mergeRemoteChanges(() => {
    editor.run(
      () => {
        const stale = editor.getCurrentPageShapes().filter((sh) => isBackendShape(sh.id)).map((sh) => sh.id)
        if (stale.length) editor.deleteShapes(stale)
        for (const d of orderForCreate(descs)) {
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
  const descs = state.artifacts.flatMap(expandArtifact)
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

        for (const d of orderForCreate(descs)) {
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
          } else if (d.type === FRAME) {
            editor.updateShape({
              id: d.id,
              type: FRAME,
              props: { name: d.props.name, w: d.props.w, h: d.props.h },
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
