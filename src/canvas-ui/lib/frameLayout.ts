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
/** Horizontal gap left between adjacent columns when they're re-flowed to clean,
 * non-overlapping x positions. Also the width of a unit column's gutter, so a
 * wide block's span lines up exactly with the columns it covers. */
const COL_GAP = 40

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

/** A box tagged with the id of the shape/element it belongs to. */
export interface LayoutBox extends Box {
  id: string
}

/**
 * Pack boxes into a clean, non-overlapping, size-aware masonry (frame-local
 * coordinates) and return the new top-left for every box, keyed by id.
 *
 * The old packer clustered boxes by x and advanced each column by the widest box
 * in it — so a single wide block (a full-width header, a hero card) inflated its
 * whole column's stride, leaving a dead gap to its right and trapping the narrow
 * blocks that happened to share its x into one lonely column. This version is
 * width-aware instead:
 *   1. a *unit column* = the median block width (robust to a stray tiny/wide card);
 *      every block spans a whole number of unit columns (`span`), so a wide block
 *      lines up across several while normal cards stay one wide;
 *   2. the column count `N` is derived from total content height (a square-ish,
 *      balanced masonry) but never narrower than the widest block's span — and,
 *      being computed from sizes not positions, it doesn't drift as blocks move;
 *   3. blocks flow in reading order into the column-window whose tallest column is
 *      lowest (shortest-stack-first), so narrow blocks fill in beside and beneath
 *      wide ones instead of stacking in a single column.
 *
 * The mapping is idempotent — every input that affects the output (unit, N, spans,
 * the anchoring top-left) is a function of the block *sizes*, not their current
 * positions, and the reading order is iterated to a fixed point — so feeding it
 * its own output moves nothing. That's why it can back BOTH the live auto-reflow
 * (`relayoutFrame`, over a frame's un-pinned blocks) and the manual tidy
 * (`backendSync.tidyFrame`, over every block) and still reload to an identical
 * layout.
 */
export function packColumns(boxes: LayoutBox[]): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>()
  if (!boxes.length) return out
  // Anchor the masonry at the group's current top-left so it stays put. Column 0
  // always takes the first-placed block, so `left` survives a re-pack unchanged.
  const top = Math.min(...boxes.map((b) => b.y))
  const left = Math.min(...boxes.map((b) => b.x))

  // Unit column = the *median* block width. The median (not the min) is what keeps
  // a stray tiny card — or a couple of wide ones — from skewing the grid: it tracks
  // the "normal" card so most blocks stay one column wide while the genuinely wide
  // ones span several. A block of width w covers `span` columns, where one column
  // is `unit` wide with a COL_GAP gutter (span·unit + (span−1)·COL_GAP ≥ w). `ceil`
  // (never round) guarantees a block always gets at least as many columns as its
  // width needs, so it can never spill into a neighbour. The widest block's span is
  // the floor on how many columns we need.
  const widths = boxes.map((b) => b.w).sort((a, b) => a - b)
  const mid = widths.length >> 1
  const unit = widths.length % 2 ? widths[mid] : (widths[mid - 1] + widths[mid]) / 2
  const stride = unit + COL_GAP
  const spanOf = (b: Box) => Math.max(1, Math.ceil((b.w + COL_GAP) / stride))
  const maxSpan = Math.max(...boxes.map(spanOf))

  // Column count: balanced for a square-ish footprint, widened to fit the widest
  // block, capped at the block count so no column is left empty (an empty trailing
  // column would shrink the footprint and break idempotency). Derived from sizes
  // only — independent of where the blocks currently sit.
  const totalH = boxes.reduce((s, b) => s + b.h + ROW_GAP, 0)
  const balanced = Math.max(1, Math.round(Math.sqrt(totalH / stride)))
  const N = Math.min(boxes.length, Math.max(maxSpan, balanced))

  // One masonry pass over a given reading order: place each block in the column
  // window [c, c+span) whose tallest column is lowest (ties → leftmost), then
  // raise those columns past it. Records each block's column for stable ordering.
  const place = (order: LayoutBox[]) => {
    const bottom = new Array<number>(N).fill(top)
    const pos = new Map<string, { x: number; y: number; c: number }>()
    for (const b of order) {
      const span = Math.min(N, spanOf(b))
      let bestC = 0
      let bestY = Infinity
      for (let c = 0; c + span <= N; c++) {
        let y = top
        for (let k = c; k < c + span; k++) y = Math.max(y, bottom[k])
        if (y < bestY) {
          bestY = y
          bestC = c
        }
      }
      pos.set(b.id, { x: left + bestC * stride, y: bestY, c: bestC })
      for (let k = bestC; k < bestC + span; k++) bottom[k] = bestY + b.h + ROW_GAP
    }
    return pos
  }

  // Reading order, iterated to a fixed point: start from the blocks' current
  // (y, x), re-pack, then re-derive the order from the produced layout and repeat
  // until it stops changing. At convergence sort(output) == the order that built
  // it, which is exactly what makes pack(pack(x)) == pack(x).
  let order = [...boxes].sort((a, b) => a.y - b.y || a.x - b.x)
  let pos = place(order)
  for (let i = 0; i < 5; i++) {
    const next = [...boxes].sort((a, b) => {
      const pa = pos.get(a.id)!
      const pb = pos.get(b.id)!
      return pa.y - pb.y || pa.c - pb.c
    })
    if (next.every((b, idx) => b.id === order[idx].id)) break
    order = next
    pos = place(order)
  }

  for (const b of boxes) {
    const p = pos.get(b.id)!
    out.set(b.id, { x: p.x, y: p.y })
  }
  return out
}

/**
 * Re-flow `frameId` so its children never overlap, then size the frame to fit.
 *
 * AI/backend frames (`shape:art-…`) are masonry-arranged by `packColumns`: the
 * column grid is sized to the blocks (a wide block spans several columns), and
 * blocks flow in reading order into the shortest column-window. This kills
 * horizontal overlap — a stray block the agent dropped at a colliding x is pulled
 * onto a real column instead of floating on top of its neighbours, and a wide
 * block no longer strands its narrow siblings in a lonely column — while the
 * stacking kills vertical overlap, so a grown block slides the ones below it down
 * (and they pack back up when it shrinks). Pinned blocks (ones the user moved)
 * keep their place and only count toward the enclosure.
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
  const moves: { shape: TLShape; x: number; y: number }[] = []

  if (arrange) {
    // A block the user has moved/resized is "pinned" (meta.pinned) — leave it
    // exactly where they put it; only the untouched, agent-placed blocks reflow,
    // so manual placement always wins while AI frames still auto-arrange. (The
    // manual "tidy" button clears every pin and packs all of them — tidyFrame.)
    const free = kids.filter((k) => (k.meta as { pinned?: unknown }).pinned !== true)
    if (free.length) {
      const pos = packColumns(free.map((k) => ({ id: k.id, ...(boxOf(k) as Box) })))
      for (const k of free) {
        const p = pos.get(k.id)
        if (p && (Math.abs(k.x - p.x) > 0.5 || Math.abs(k.y - p.y) > 0.5)) moves.push({ shape: k, x: p.x, y: p.y })
      }
    }
  }

  // Enclosing box, accounting for any pending moves.
  const moved = new Map(moves.map((m) => [m.shape.id, m]))
  const box = frameBox(
    kids.map((k) => {
      const b = boxOf(k) as Box
      const m = moved.get(k.id)
      return m ? { ...b, x: m.x, y: m.y } : b
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
          editor.updateShape({ id: m.shape.id, type: m.shape.type, x: m.x, y: m.y })
        }
        if (frameChanged) editor.updateShape({ id: frameId, type: 'frame', props: { w: targetW, h: targetH } })
      },
      { history: 'ignore' },
    )
  })
}
