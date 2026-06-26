'use client'

import { useEffect, useRef, useState } from 'react'
import { gsap } from 'gsap'
import { react, type Editor, type TLShape, type TLShapeId } from 'tldraw'
import { useIsoLayoutEffect } from '@/lib/useIso'
import { useRainyStore } from '@/lib/store'
import { RAINY_TEXT, VIDEO_BLOCK, IMAGE_BLOCK, getTextParts, parse } from '@/lib/blockTypes'

/** The live tldraw editor, published on the window by CanvasWorkspace.onMount. */
const ed = (): Editor | undefined =>
  typeof window !== 'undefined' ? (window as any).__rainyEditor : undefined

function withEditor(fn: (e: Editor) => void) {
  const e = ed()
  if (e && !e.isDisposed) fn(e)
}

// ===========================================================================
// Outline model — a hierarchical map of everything on the canvas. Frames are
// branches; their child blocks (tldraw parentId) nest underneath. This mirrors
// the canvas rather than driving block edits: it's a navigator, not an editor.
// ===========================================================================

type Kind = 'text' | 'video' | 'image' | 'frame' | 'other'

interface OutlineNode {
  id: string
  type: string
  kind: Kind
  name: string
  depth: number
  children: OutlineNode[]
}

function nodeKind(type: string): Kind {
  if (type === RAINY_TEXT) return 'text'
  if (type === VIDEO_BLOCK) return 'video'
  if (type === IMAGE_BLOCK) return 'image'
  if (type === 'frame') return 'frame'
  return 'other'
}

function firstLine(s: string): string {
  return (s || '')
    .split('\n')
    .map((x) => x.trim())
    .find(Boolean) ?? ''
}

function shapeLabel(type: string): string {
  return type.replace(/[-_]/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}

/** A human label for a shape, derived from whatever content it carries. */
function deriveName(shape: TLShape): string {
  const p = shape.props as any
  switch (shape.type) {
    case 'frame':
      return (typeof p.name === 'string' && p.name.trim()) || 'Frame'
    case RAINY_TEXT: {
      const parts = getTextParts(String(p.html ?? ''))
      return parts.title.trim() || firstLine(parts.body) || 'Text'
    }
    case VIDEO_BLOCK: {
      const d = parse(String(p.data ?? ''))
      return (d.title && d.title.trim()) || 'Video'
    }
    case IMAGE_BLOCK:
      return (
        (typeof p.caption === 'string' && p.caption.trim()) ||
        (typeof p.shotType === 'string' && p.shotType.trim()) ||
        'Image'
      )
    default:
      return shapeLabel(shape.type)
  }
}

/** Does this store change-batch affect the outline (membership, order, or a
 * displayed name)? Skips pure-geometry churn (w/h-only relayout, camera frames)
 * that the outline doesn't reflect. The serialized-key diff in recompute() is the
 * backstop, so being conservative here only costs an occasional extra rebuild. */
function isOutlineRelevant(entry: any): boolean {
  const added = Object.values(entry.changes.added) as any[]
  if (added.some((r) => r.typeName === 'shape')) return true
  const removed = Object.values(entry.changes.removed) as any[]
  if (removed.some((r) => r.typeName === 'shape')) return true
  for (const pair of Object.values(entry.changes.updated) as any[]) {
    const [from, to] = pair
    if (to?.typeName !== 'shape') continue
    if (from.parentId !== to.parentId || from.index !== to.index || from.type !== to.type) return true
    if (from.x !== to.x || from.y !== to.y) return true // siblings are y/x-sorted
    const pf = from.props ?? {}
    const pt = to.props ?? {}
    if (pf.name !== pt.name || pf.html !== pt.html || pf.data !== pt.data) return true
    if (pf.caption !== pt.caption || pf.shotType !== pt.shotType) return true
  }
  return false
}

/** Walk the page's shape tree into an ordered, nested outline.
 * Siblings are sorted top-to-bottom then left-to-right so the list reads in the
 * same order the eye scans the canvas (child coords share a parent space, so a
 * raw x/y compare is valid within each sibling group). */
function buildTree(e: Editor): OutlineNode[] {
  const walk = (parentId: TLShapeId | ReturnType<Editor['getCurrentPageId']>, depth: number): OutlineNode[] => {
    const shapes = e
      .getSortedChildIdsForParent(parentId as any)
      .map((id) => e.getShape(id))
      .filter((s): s is TLShape => !!s)
    shapes.sort((a, b) => a.y - b.y || a.x - b.x)
    return shapes.map((shape) => ({
      id: shape.id,
      type: shape.type,
      kind: nodeKind(shape.type),
      name: deriveName(shape),
      depth,
      children: shape.type === 'frame' ? walk(shape.id, depth + 1) : [],
    }))
  }
  return walk(e.getCurrentPageId(), 0)
}

/**
 * Reactively snapshot the canvas as an outline tree plus the currently hovered
 * shape (canvas → sidebar highlight).
 *
 * Tree: rebuilt on any document-scoped store change (add / remove / move /
 * rename), coalesced to a frame and diffed by a serialized key so unrelated
 * churn (e.g. a drag that doesn't reorder) doesn't re-render the list.
 *
 * Hover: `hoveredShapeId` is session-scoped instance state, not a document
 * record, so we track it with a tldraw reactor instead of the store listener.
 *
 * Re-keyed on the project so a project switch (which remounts the editor)
 * re-acquires the new instance.
 */
function useOutline(): { tree: OutlineNode[]; hoveredId: string | null } {
  const projectId = useRainyStore((s) => s.currentProjectId)
  const [tree, setTree] = useState<OutlineNode[]>([])
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const lastKey = useRef('')

  useEffect(() => {
    let cancelled = false
    let raf = 0
    let scheduled = 0
    let unlisten: (() => void) | undefined
    let stopHover: (() => void) | undefined

    const recompute = () => {
      const e = ed()
      if (!e || e.isDisposed) return
      const next = buildTree(e)
      const key = JSON.stringify(next)
      if (key !== lastKey.current) {
        lastKey.current = key
        setTree(next)
      }
    }

    const schedule = (entry?: any) => {
      // Skip batches that can't change the outline (e.g. relayout's frame w/h-only
      // update, video/image size patches, pure camera frames) — only rebuild +
      // re-stringify the whole tree when an outline-visible field actually moved.
      // Keeps the heavy walk off the hot path during agent streaming / reflow.
      if (entry && !isOutlineRelevant(entry)) return
      if (scheduled) return
      scheduled = requestAnimationFrame(() => {
        scheduled = 0
        recompute()
      })
    }

    const attach = () => {
      if (cancelled) return
      const e = ed()
      if (!e || e.isDisposed) {
        raf = requestAnimationFrame(attach)
        return
      }
      recompute()
      unlisten = e.store.listen(schedule, { scope: 'document' })
      stopHover = react('outline:hover', () => {
        const id = e.getHoveredShapeId()
        setHoveredId(id ? String(id) : null)
      })
    }
    attach()

    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      if (scheduled) cancelAnimationFrame(scheduled)
      unlisten?.()
      stopHover?.()
    }
  }, [projectId])

  return { tree, hoveredId }
}

// ===========================================================================
// Operations — selection / reveal / hover, driven from the outline against the
// editor we hold via the window handle.
// ===========================================================================

/** Push hover onto the canvas (sidebar → canvas highlight). Passing null clears
 * it; the canvas reclaims hover from the pointer the moment it re-enters. */
const setCanvasHover = (id: string | null) =>
  withEditor((e) => e.setHoveredShape((id as TLShapeId) ?? null))

/** Click a row: select it (⌘/⇧ toggles into the existing selection). */
function selectFromRow(id: string, additive: boolean) {
  withEditor((e) => {
    if (additive) {
      const cur = e.getSelectedShapeIds().map(String)
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]
      e.select(...(next as TLShapeId[]))
    } else {
      e.select(id as TLShapeId)
    }
  })
}

/** Double-click a row: select and bring the shape into view. */
function revealFromRow(id: string) {
  withEditor((e) => {
    e.select(id as TLShapeId)
    e.zoomToSelection({ animation: { duration: 250 } })
  })
}

const duplicate = (ids: string[]) =>
  withEditor((e) => e.duplicateShapes(ids as TLShapeId[], { x: 28, y: 28 }))
const remove = (ids: string[]) => withEditor((e) => e.deleteShapes(ids as TLShapeId[]))

// ===========================================================================
// Sidebar shell — header + collapse/intro animation + the outline body.
// ===========================================================================

export default function Sidebar() {
  const ref = useRef<HTMLElement>(null)
  const collapsed = useRainyStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useRainyStore((s) => s.toggleSidebar)
  const selectedIds = useRainyStore((s) => s.selectedIds)
  const { tree, hoveredId } = useOutline()

  // Intro animation (runs once). Scoped in a gsap.context so it reverts cleanly
  // and never clobbers the collapse tween below.
  useIsoLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ctx = gsap.context(() => {
      gsap.from(el, { x: -16, autoAlpha: 0, duration: 0.5, ease: 'power3.out' })
    })
    return () => ctx.revert()
  }, [])

  // Collapse / expand. GSAP must own this: the intro leaves an inline transform
  // on the <aside>, and an inline transform beats any stylesheet rule — so a
  // CSS-class approach silently does nothing. Animating the same inline
  // transform here is what actually slides the panel, smoothly both ways.
  const firstRun = useRef(true)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (firstRun.current) {
      firstRun.current = false
      return
    }
    const hideX = -(el.offsetWidth + 28) // width + left inset + shadow, fully off-screen
    gsap.to(el, {
      x: collapsed ? hideX : 0,
      autoAlpha: collapsed ? 0 : 1,
      duration: 0.42,
      ease: collapsed ? 'power3.in' : 'power3.out',
      overwrite: 'auto',
    })
  }, [collapsed])

  const count = countNodes(tree)
  const hasSel = selectedIds.length > 0

  return (
    <>
      <aside className="rainy-sidebar" ref={ref}>
        <div className="ci">
          <div className="ci-head">
            <div className="ci-title">
              Layers
              {count > 0 && <span className="ci-count">{count}</span>}
            </div>
            <div className="ci-head-actions">
              {hasSel && (
                <>
                  <button
                    type="button"
                    className="ci-act"
                    title={`Duplicate${selectedIds.length > 1 ? ` (${selectedIds.length})` : ''}`}
                    aria-label="Duplicate"
                    onClick={() => duplicate(selectedIds)}
                  >
                    <CopyIcon />
                  </button>
                  <button
                    type="button"
                    className="ci-act danger"
                    title={`Delete${selectedIds.length > 1 ? ` (${selectedIds.length})` : ''}`}
                    aria-label="Delete"
                    onClick={() => remove(selectedIds)}
                  >
                    <TrashIcon />
                  </button>
                  <span className="ci-act-sep" />
                </>
              )}
              <button
                type="button"
                className="ci-collapse"
                title="Hide sidebar"
                aria-label="Hide sidebar"
                onClick={toggleSidebar}
              >
                <SidebarIcon size={18} />
              </button>
            </div>
          </div>

          <Outline tree={tree} selectedIds={selectedIds} hoveredId={hoveredId} />
        </div>
      </aside>

      <button
        type="button"
        className={`rainy-sidebar-show${collapsed ? ' show' : ''}`}
        title="Show sidebar"
        aria-label="Show sidebar"
        onClick={toggleSidebar}
      >
        <SidebarIcon size={19} />
      </button>
    </>
  )
}

function countNodes(nodes: OutlineNode[]): number {
  return nodes.reduce((n, node) => n + 1 + countNodes(node.children), 0)
}

// ===========================================================================
// Outline body — the scrollable tree, with collapse, selection, and the
// bidirectional hover highlight.
// ===========================================================================

function Outline({
  tree,
  selectedIds,
  hoveredId,
}: {
  tree: OutlineNode[]
  selectedIds: string[]
  hoveredId: string | null
}) {
  // Frames the user has twirled shut. Default-open: the whole point is to see
  // everything at a glance.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const selected = new Set(selectedIds)

  const rows: OutlineNode[] = []
  const flatten = (nodes: OutlineNode[]) => {
    for (const n of nodes) {
      rows.push(n)
      if (n.children.length && !collapsed.has(n.id)) flatten(n.children)
    }
  }
  flatten(tree)

  if (rows.length === 0) {
    return (
      <div className="outline outline-empty">
        <span className="outline-empty-icon">
          <FrameIcon />
        </span>
        <p className="outline-empty-title">Nothing on the canvas</p>
        <p className="outline-empty-text">
          Blocks and frames your agent adds — or you create — show up here, nested by frame.
        </p>
      </div>
    )
  }

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  return (
    <div className="outline" role="tree">
      {rows.map((node) => (
        <Row
          key={node.id}
          node={node}
          selected={selected.has(node.id)}
          hovered={hoveredId === node.id}
          collapsed={collapsed.has(node.id)}
          onToggle={toggle}
        />
      ))}
    </div>
  )
}

function Row({
  node,
  selected,
  hovered,
  collapsed,
  onToggle,
}: {
  node: OutlineNode
  selected: boolean
  hovered: boolean
  collapsed: boolean
  onToggle: (id: string) => void
}) {
  const isFrame = node.kind === 'frame'
  const hasChildren = node.children.length > 0
  return (
    <div
      role="treeitem"
      aria-selected={selected}
      className={`outline-row${selected ? ' is-selected' : ''}${hovered ? ' is-hovered' : ''}`}
      style={{ paddingLeft: 8 + node.depth * 14 }}
      onMouseEnter={() => setCanvasHover(node.id)}
      onMouseLeave={() => setCanvasHover(null)}
      onClick={(e) => selectFromRow(node.id, e.metaKey || e.ctrlKey || e.shiftKey)}
      onDoubleClick={() => revealFromRow(node.id)}
      title={node.name}
    >
      {isFrame && hasChildren ? (
        <button
          type="button"
          className="outline-twirl"
          aria-label={collapsed ? 'Expand' : 'Collapse'}
          onClick={(e) => {
            e.stopPropagation()
            onToggle(node.id)
          }}
        >
          <Twirl open={!collapsed} />
        </button>
      ) : (
        <span className="outline-twirl-spacer" />
      )}
      <span className={`outline-ico k-${node.kind}`}>
        <TypeIcon kind={node.kind} />
      </span>
      <span className="outline-name">{node.name}</span>
      {isFrame && hasChildren && <span className="outline-badge">{node.children.length}</span>}
    </div>
  )
}

// ===========================================================================
// Icons
// ===========================================================================

function TypeIcon({ kind }: { kind: Kind }) {
  switch (kind) {
    case 'text':
      return <TextIcon />
    case 'video':
      return <VideoIcon />
    case 'image':
      return <ImageIcon />
    case 'frame':
      return <FrameIcon />
    default:
      return <BlockIcon />
  }
}

const ICO = {
  width: 15,
  height: 15,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

function TextIcon() {
  return (
    <svg {...ICO}>
      <path d="M5 6h14M12 6v12M9 18h6" />
    </svg>
  )
}

function VideoIcon() {
  return (
    <svg {...ICO}>
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <path d="M10 9.2l5 2.8-5 2.8z" fill="currentColor" stroke="none" />
    </svg>
  )
}

function ImageIcon() {
  return (
    <svg {...ICO}>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <circle cx="8.5" cy="9.5" r="1.4" />
      <path d="M21 15.5l-4.5-4.5L6 21" />
    </svg>
  )
}

function FrameIcon() {
  return (
    <svg {...ICO}>
      <path d="M8 2v20M16 2v20M2 8h20M2 16h20" />
    </svg>
  )
}

function BlockIcon() {
  return (
    <svg {...ICO}>
      <rect x="5" y="5" width="14" height="14" rx="3" />
    </svg>
  )
}

function Twirl({ open }: { open: boolean }) {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .14s ease' }}
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  )
}

/**
 * SF Symbols–style `sidebar.left` glyph: a rounded rectangle with a leading
 * divider marking off the sidebar column. Used as the single toggle icon for
 * both hide (in-panel) and show (floating) controls, matching macOS.
 */
function SidebarIcon({ size = 19 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="14" rx="2.8" />
      <path d="M9 5v14" />
    </svg>
  )
}

function CopyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7h16M10 11v6M14 11v6M5 7l1 13a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1l1-13M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" />
    </svg>
  )
}
