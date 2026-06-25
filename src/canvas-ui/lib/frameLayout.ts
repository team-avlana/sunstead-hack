/**
 * Frame auto-layout — keeps a flow's blocks from overlapping as they resize.
 *
 * Text blocks now hug their content (see RainyTextShape) and video blocks change
 * height as they expand/analyse, so the fixed grid positions a frame is seeded
 * with go stale the moment a block grows. `relayoutFrame` re-flows a frame's
 * children — masonry-stacking each column so nothing overlaps — and then sizes
 * the frame to enclose them.
 *
 * Framework-free beyond tldraw: callable from the shape utils (inside <Tldraw>)
 * and from the backend renderer (backendCanvas). Writes are applied as `remote`
 * changes (like the reconcile loop) so this derived layout never echoes back out
 * to Postgres as user edits; they're also history-ignored and diff-based, so it's
 * a no-op when nothing moved and safe to call on every resize.
 */
import { type Editor, type TLShape, type TLShapeId } from 'tldraw'

/** Inner padding between the furthest child edge and the frame border. The top
 * gets extra room (the child grid already starts inset) for the frame's label. */
export const FRAME_PAD = 40
export const FRAME_PAD_TOP = 56
/** A frame with no blocks still needs a usable footprint. */
export const FRAME_MIN_W = 360
export const FRAME_MIN_H = 280
/** Vertical gap left between blocks stacked in the same column. */
const ROW_GAP = 24
/** Two children belong to the same column when their x is within this tolerance
 * (grid columns share an x; the slack tolerates a nudge or sub-pixel drift). */
const COL_TOL = 120

interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** The frame box (frame-local) that encloses a set of child boxes, plus padding. */
export function frameBox(children: Box[]): { w: number; h: number } {
  let maxRight = 0
  let maxBottom = 0
  for (const c of children) {
    maxRight = Math.max(maxRight, c.x + c.w)
    maxBottom = Math.max(maxBottom, c.y + c.h)
  }
  return {
    w: Math.max(FRAME_MIN_W, maxRight + FRAME_PAD),
    h: Math.max(FRAME_MIN_H, maxBottom + FRAME_PAD_TOP),
  }
}

/** A child's frame-local box, or null if it carries no numeric w/h. */
function boxOf(sh: TLShape): Box | null {
  const p = sh.props as { w?: unknown; h?: unknown }
  if (typeof p.w !== 'number' || typeof p.h !== 'number') return null
  return { x: sh.x, y: sh.y, w: p.w, h: p.h }
}

/**
 * Re-flow `frameId` so its children never overlap, then size the frame to fit.
 *
 * AI/backend frames (`shape:art-…`) are masonry-arranged: children are clustered
 * into columns by x, and within each column stacked top-to-bottom with a fixed
 * gap from a shared top edge — so when one block grows, the ones below it slide
 * down (and pack back up when it shrinks) instead of overlapping. Pinned blocks
 * (ones the user moved) keep their place and only count toward the enclosure.
 * User-created frames are left alone and only grown to keep covering content.
 */
export function relayoutFrame(editor: Editor, frameId: TLShapeId): void {
  const frame = editor.getShape(frameId)
  if (!frame || frame.type !== 'frame') return

  const kids = editor
    .getSortedChildIdsForParent(frameId)
    .map((id) => editor.getShape(id))
    .filter((sh): sh is TLShape => !!sh && !!boxOf(sh))
  if (!kids.length) return

  const arrange = String(frameId).startsWith('shape:art-')
  const moves: { shape: TLShape; y: number }[] = []

  if (arrange) {
    // A block the user has moved/resized is "pinned" (meta.pinned) — leave it
    // exactly where they put it; only the untouched, agent-placed blocks reflow.
    // So manual placement always wins while AI frames still auto-arrange.
    const free = kids.filter((k) => (k.meta as { pinned?: unknown }).pinned !== true)
    if (free.length) {
      const top = Math.min(...free.map((k) => k.y))
      // Cluster into columns by x, then stack each column from the shared top.
      const cols: TLShape[][] = []
      for (const k of [...free].sort((a, b) => a.x - b.x)) {
        const col = cols.find((c) => Math.abs(c[0].x - k.x) <= COL_TOL)
        if (col) col.push(k)
        else cols.push([k])
      }
      for (const col of cols) {
        let y = top
        for (const k of col.sort((a, b) => a.y - b.y)) {
          if (Math.abs(k.y - y) > 0.5) moves.push({ shape: k, y })
          y += (boxOf(k) as Box).h + ROW_GAP
        }
      }
    }
  }

  // Enclosing box, accounting for any pending moves.
  const movedY = new Map(moves.map((m) => [m.shape.id, m.y]))
  const box = frameBox(
    kids.map((k) => {
      const b = boxOf(k) as Box
      return { ...b, y: movedY.get(k.id) ?? b.y }
    }),
  )
  const fp = frame.props as { w: number; h: number }
  // Backend frames fit exactly; user frames only grow (respect a manual resize).
  const targetW = arrange ? box.w : Math.max(fp.w, box.w)
  const targetH = arrange ? box.h : Math.max(fp.h, box.h)
  const frameChanged = Math.abs(fp.w - targetW) > 0.5 || Math.abs(fp.h - targetH) > 0.5

  if (!moves.length && !frameChanged) return

  // `remote` (not `user`) so the outbound sync ignores it — layout is derived,
  // not an edit. mergeRemoteChanges no-ops when already in a remote batch (e.g.
  // backendCanvas), so this is safe to call from anywhere outside an atomic op.
  editor.store.mergeRemoteChanges(() => {
    editor.run(
      () => {
        for (const m of moves) {
          editor.updateShape({ id: m.shape.id, type: m.shape.type, x: m.shape.x, y: m.y })
        }
        if (frameChanged) editor.updateShape({ id: frameId, type: 'frame', props: { w: targetW, h: targetH } })
      },
      { history: 'ignore' },
    )
  })
}
