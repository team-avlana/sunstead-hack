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
import { IMAGE_BLOCK, RAINY_TEXT, VIDEO_BLOCK, composeTextHtml, dims, type TextFormat, type VideoData } from '@/lib/blockTypes'
import {
  fetchProjectState,
  resolveAssetUrl,
  type EnrichedArtifact,
  type ProjectState,
} from './api'
import {
  isArtifactAdopted,
  isArtifactPendingDelete,
  isContentDirty,
  isElementPendingRemove,
  resolveArtRef,
} from './backendSync'
import { frameBox, relayoutFrame } from './frameLayout'
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
  /** tldraw shape meta — `pinned:true` opts a block out of frame auto-layout once
   * the user has moved/resized it (so manual placement survives reload). */
  meta?: Record<string, unknown>
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

/** Image Block props from an `image` element. The element's src is a backend
 * path (`/frames/{id}`, `/api/storyboard/{id}`), a data: URL, or an absolute
 * URL — resolveAssetUrl makes relative paths absolute and passes the rest
 * through. The caption falls back through concept/label; shot_type is an
 * optional badge. Storyboard panels declare their own w/h (16:9 vs square). */
function imageShapeProps(el: Record<string, unknown>): { w: number; h: number; src: string; caption: string; shotType: string } {
  const str = (k: string): string | undefined => (typeof el[k] === 'string' ? (el[k] as string) : undefined)
  const w = typeof el.w === 'number' ? el.w : 360
  const h = typeof el.h === 'number' ? el.h : 224
  const src = resolveAssetUrl(str('src') ?? str('url')) ?? ''
  const caption = str('caption') ?? str('concept') ?? str('label') ?? ''
  const shotType = str('shot_type') ?? str('shotType') ?? ''
  return { w, h, src, caption, shotType }
}

/** A text element's body. Prefer the self-describing structured form
 * ({format, title, subtitle, body}) — that's what carries the layout the user
 * picked — and fall back to a raw `content` HTML/plain string, then a label. */
function elementTextHtml(el: Record<string, unknown>): string {
  const str = (k: string): string | undefined => (typeof el[k] === 'string' ? (el[k] as string) : undefined)
  const hasParts =
    (typeof el.format === 'string' && el.format) ||
    ['title', 'subtitle', 'body'].some((k) => str(k)?.trim())
  if (hasParts) {
    return composeTextHtml({
      format: el.format as TextFormat | undefined,
      title: str('title'),
      subtitle: str('subtitle'),
      body: str('body'),
    })
  }
  const content = el.content
  if (typeof content === 'string' && content.trim()) {
    return looksLikeHtml(content) ? content : `<p>${escapeHtml(content)}</p>`
  }
  const label = (el.label ?? el.text) as string | undefined
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

/** Seed frame box from its children so it covers them on first paint. Once the
 * shapes mount, `relayoutFrame` (lib/frameLayout) owns sizing + reflow as blocks
 * resize. Child x/y are frame-local; the DB's position.w/h is intentionally
 * ignored. */
function frameSizeFor(children: ShapeDesc[]): { w: number; h: number } {
  return frameBox(
    children.map((c) => ({
      x: c.x,
      y: c.y,
      w: typeof c.props.w === 'number' ? (c.props.w as number) : 0,
      h: typeof c.props.h === 'number' ? (c.props.h as number) : 0,
    })),
  )
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
    const name = (payload.label as string) || a.title || 'Flow'
    const frameId = artId(a.artifact_id)

    // Build the child shapes first; the frame is then sized to enclose them.
    const children: ShapeDesc[] = []
    const els = Array.isArray(payload.elements) ? (payload.elements as Record<string, unknown>[]) : []
    els.forEach((el, i) => {
      // Stable per-element shape id; x/y are relative to the frame.
      const id = artId(`${a.artifact_id}::${String(el.id ?? `el-${i}`)}`)
      const ex = typeof el.x === 'number' ? el.x : 32 + (i % 2) * 360
      const ey = typeof el.y === 'number' ? el.y : 64 + Math.floor(i / 2) * 260
      // A block the user has moved/resized is pinned: keep it out of masonry.
      const meta = { pinned: el.pinned === true }
      if (el.type === 'video') {
        children.push({ id, type: VIDEO_BLOCK, x: ex, y: ey, parentId: frameId, meta, props: videoShapeProps(el) })
      } else if (el.type === 'image') {
        children.push({ id, type: IMAGE_BLOCK, x: ex, y: ey, parentId: frameId, meta, props: imageShapeProps(el) })
      } else {
        const ew = typeof el.w === 'number' ? el.w : 320
        const eh = typeof el.h === 'number' ? el.h : 200
        children.push({ id, type: RAINY_TEXT, x: ex, y: ey, parentId: frameId, meta, props: { w: ew, h: eh, html: elementTextHtml(el) } })
      }
    })

    const { w, h } = frameSizeFor(children)
    return [{ id: frameId, type: FRAME, x, y, props: { name, w, h } }, ...children]
  }

  // Legacy standalone artifacts (no enclosing frame).
  if (a.type === 'video') {
    const payload = (a.payload ?? {}) as Record<string, unknown>
    return [{ id: artId(a.artifact_id), type: VIDEO_BLOCK, x, y, props: videoShapeProps({ ...payload, video: a.video, title: a.title }) }]
  }
  // Match the default text-card footprint (= analysed/expanded video block).
  const w = typeof pos.w === 'number' ? pos.w : 360
  const h = typeof pos.h === 'number' ? pos.h : 332
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
        // Pack each frame to its (seed-sized) blocks; the blocks' own auto-fit
        // re-flows the frame again once they measure their real content height.
        for (const d of descs) if (d.type === FRAME) relayoutFrame(editor, d.id)
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
          // Skip artifacts the user is locally authoring (adopted shape owns them)
          // or just deleted (don't resurrect from a stale read).
          const ref = resolveArtRef(d.id)
          if (ref && (isArtifactAdopted(ref.artifactId) || isArtifactPendingDelete(ref.artifactId))) {
            continue
          }
          if (ref?.elementId && isElementPendingRemove(ref.artifactId, ref.elementId)) continue

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
            // Size + child layout are owned by relayoutFrame (run after this loop,
            // and again as blocks auto-fit). Here we only refresh the name, and
            // only when the user isn't mid-rename.
            if (!isContentDirty(editor, d.id)) {
              editor.updateShape({ id: d.id, type: FRAME, props: { name: d.props.name } } as any)
            }
          } else if (d.type === IMAGE_BLOCK) {
            // Refresh the image source + caption (the underlying frame/panel can
            // change), but keep the user's chosen size (w/h aren't patched, so a
            // manual resize survives the re-pull).
            editor.updateShape({
              id: d.id,
              type: IMAGE_BLOCK,
              props: { src: d.props.src, caption: d.props.caption, shotType: d.props.shotType },
            } as any)
          } else if (d.type === RAINY_TEXT) {
            // Don't overwrite text the user is editing / just edited before it
            // round-trips to the DB.
            if (!isContentDirty(editor, d.id)) {
              editor.updateShape({ id: d.id, type: RAINY_TEXT, props: { html: d.props.html } } as any)
            }
          }
        }

        // Remove backend shapes whose artifact no longer exists.
        for (const [id] of existing) {
          if (!desiredIds.has(id)) editor.deleteShapes([id])
        }

        // Re-flow each frame around the patched content (new video sizes, added
        // blocks). Text height changes re-trigger relayout as the cards re-fit.
        for (const d of descs) if (d.type === FRAME) relayoutFrame(editor, d.id)
      },
      { history: 'ignore' },
    )
  })
}
