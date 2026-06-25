'use client'

import { useEffect, useRef, useState } from 'react'
import { createShapeId, useEditor, useValue, type Editor } from 'tldraw'
import { RAINY_TEXT } from './RainyTextShape'
import { VIDEO_BLOCK } from './VideoBlockShape'

/**
 * Bottom dock — the primary way to add blocks to the canvas.
 *
 * Two kinds of buttons:
 *   - **insert** shapes (Text/Note/Frame + the geo shapes) drop a shape at the
 *     viewport centre and select it — immediate, like the original Text card.
 *   - **tool** buttons (Draw/Highlight/Arrow/Line/Eraser/Laser/Hand/Select)
 *     activate the matching built-in tldraw tool; the active one is highlighted.
 *
 * Everything here is stock tldraw (`createShape` / `setCurrentTool`) except the
 * Rainy text card and the (still-stubbed) Video block. Rendered inside <Tldraw>
 * via `InFrontOfTheCanvas`, so `useEditor()` resolves the live editor.
 */

// ---- creation helpers -----------------------------------------------------

const center = (editor: Editor) => editor.getViewportPageBounds().center

/** Drop a fresh Rainy text card at the viewport centre and start editing it. */
function createTextCard(editor: Editor) {
  const c = center(editor)
  const id = createShapeId()
  editor.run(() => {
    // x/y is the top-left; nudge so the default-size card lands centered.
    editor.createShape({ id, type: RAINY_TEXT, x: c.x - 220, y: c.y - 130 })
    editor.select(id)
    editor.setEditingShape(id)
  })
}

/** Drop a built-in tldraw shape centered in the viewport and select it. */
function createCentered(editor: Editor, type: string, w: number, h: number, props?: Record<string, unknown>) {
  const c = center(editor)
  const id = createShapeId()
  editor.run(() => {
    editor.createShape({ id, type, x: c.x - w / 2, y: c.y - h / 2, props } as any)
    editor.select(id)
  })
}

/** Drop a fresh, empty Video Block (ready-for-input) at the viewport centre. */
function createVideoBlock(editor: Editor) {
  const c = center(editor)
  const id = createShapeId()
  const data = JSON.stringify({ status: 'empty', title: '', tags: [], storyboard: [] })
  const w = 360
  const h = 178
  editor.run(() => {
    editor.createShape({
      id,
      type: VIDEO_BLOCK,
      x: c.x - w / 2,
      y: c.y - h / 2,
      props: { w, h, view: 'expanded', data },
    })
    editor.select(id)
  })
}

const createNote = (editor: Editor) => createCentered(editor, 'note', 200, 200)
const createFrame = (editor: Editor) => createCentered(editor, 'frame', 420, 300, { w: 420, h: 300 })
const createGeo = (editor: Editor, geo: string) =>
  createCentered(editor, 'geo', 160, 120, { geo, w: 160, h: 120 })

// ---- tool + shape tables --------------------------------------------------

type Tool = { id: string; label: string; icon: React.ReactNode }

// Built-in tldraw tools, grouped for the bar. `id` is the tldraw tool id.
const NAV: Tool[] = [
  { id: 'select', label: 'Select', icon: <SelectIcon /> },
  { id: 'hand', label: 'Hand (pan)', icon: <HandIcon /> },
]
const DRAW: Tool[] = [
  { id: 'draw', label: 'Draw', icon: <PencilIcon /> },
  { id: 'highlight', label: 'Highlighter', icon: <HighlightIcon /> },
  { id: 'arrow', label: 'Arrow', icon: <ArrowToolIcon /> },
  { id: 'line', label: 'Line', icon: <LineIcon /> },
]
const UTILITY: Tool[] = [
  { id: 'eraser', label: 'Eraser', icon: <EraserIcon /> },
  { id: 'laser', label: 'Laser pointer', icon: <LaserIcon /> },
]

// Every geo variant tldraw ships out of the box (TLGeoShape `geo` style).
const GEO: { geo: string; label: string }[] = [
  { geo: 'rectangle', label: 'Rectangle' },
  { geo: 'ellipse', label: 'Ellipse' },
  { geo: 'triangle', label: 'Triangle' },
  { geo: 'diamond', label: 'Diamond' },
  { geo: 'pentagon', label: 'Pentagon' },
  { geo: 'hexagon', label: 'Hexagon' },
  { geo: 'octagon', label: 'Octagon' },
  { geo: 'star', label: 'Star' },
  { geo: 'rhombus', label: 'Rhombus' },
  { geo: 'rhombus-2', label: 'Rhombus 2' },
  { geo: 'oval', label: 'Oval' },
  { geo: 'trapezoid', label: 'Trapezoid' },
  { geo: 'cloud', label: 'Cloud' },
  { geo: 'heart', label: 'Heart' },
  { geo: 'x-box', label: 'X box' },
  { geo: 'check-box', label: 'Check box' },
  { geo: 'arrow-right', label: 'Arrow right' },
  { geo: 'arrow-left', label: 'Arrow left' },
  { geo: 'arrow-up', label: 'Arrow up' },
  { geo: 'arrow-down', label: 'Arrow down' },
]

// ---- dock -----------------------------------------------------------------

export default function BottomDock() {
  const editor = useEditor()
  const tool = useValue('currentTool', () => editor.getCurrentToolId(), [editor])

  return (
    <div className="rainy-dock" onPointerDown={(e) => e.stopPropagation()}>
      {/* navigation */}
      {NAV.map((t) => (
        <ToolButton key={t.id} editor={editor} def={t} active={tool === t.id} />
      ))}
      <span className="rainy-dock-sep" />

      {/* insert blocks */}
      <button className="rainy-tool" onClick={() => createTextCard(editor)} title="Text">
        <TextIcon />
      </button>
      <button className="rainy-tool" onClick={() => createVideoBlock(editor)} title="Video block">
        <VideoIcon />
      </button>
      <button className="rainy-tool" onClick={() => createNote(editor)} title="Sticky note">
        <NoteIcon />
      </button>
      <button className="rainy-tool" onClick={() => createFrame(editor)} title="Frame">
        <FrameIcon />
      </button>
      <ShapesFlyout editor={editor} />
      <span className="rainy-dock-sep" />

      {/* draw tools */}
      {DRAW.map((t) => (
        <ToolButton key={t.id} editor={editor} def={t} active={tool === t.id} />
      ))}
      <span className="rainy-dock-sep" />

      {/* utility tools */}
      {UTILITY.map((t) => (
        <ToolButton key={t.id} editor={editor} def={t} active={tool === t.id} />
      ))}
    </div>
  )
}

/** A built-in tldraw tool button; highlighted when it's the active tool. */
function ToolButton({ editor, def, active }: { editor: Editor; def: Tool; active: boolean }) {
  return (
    <button
      className={`rainy-tool${active ? ' on' : ''}`}
      onClick={() => editor.setCurrentTool(def.id)}
      title={def.label}
    >
      {def.icon}
    </button>
  )
}

/** "Shapes" button → flyout grid with every built-in geo shape. */
function ShapesFlyout({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    // Capture phase so it still fires when the canvas (or the dock's own
    // stopPropagation) would otherwise swallow the pointerdown.
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="rainy-dock-popwrap" ref={wrapRef}>
      {open && (
        <div className="rainy-dock-pop">
          {GEO.map(({ geo, label }) => (
            <button
              key={geo}
              className="rainy-tool"
              title={label}
              onClick={() => {
                createGeo(editor, geo)
                setOpen(false)
              }}
            >
              <GeoIcon geo={geo} />
            </button>
          ))}
        </div>
      )}
      <button
        className={`rainy-tool${open ? ' on' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title="Shapes"
      >
        <ShapesIcon />
      </button>
    </div>
  )
}

// ---- icons ----------------------------------------------------------------

function Svg({ children, size = 18 }: { children: React.ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  )
}

function SelectIcon() {
  return (
    <Svg>
      <path d="M5 3l6 16 2.5-6.5L20 10z" />
    </Svg>
  )
}
function HandIcon() {
  return (
    <Svg>
      <path d="M18 11V6.5a1.5 1.5 0 0 0-3 0M15 10.5V5a1.5 1.5 0 0 0-3 0v5M12 10.5V6a1.5 1.5 0 0 0-3 0v8" />
      <path d="M9 11.5l-1.5-2a1.5 1.5 0 0 0-2.4 1.8l2.4 4.2a6 6 0 0 0 5.2 3h.8a5 5 0 0 0 5-5V9.5a1.5 1.5 0 0 0-3 0V11" />
    </Svg>
  )
}
function TextIcon() {
  return (
    <Svg>
      <path d="M4 7V5h16v2" />
      <path d="M12 5v14" />
      <path d="M9 19h6" />
    </Svg>
  )
}
function VideoIcon() {
  return (
    <Svg>
      <rect x="3" y="6" width="13" height="12" rx="2" />
      <path d="m16 10 5-3v10l-5-3" />
    </Svg>
  )
}
function NoteIcon() {
  return (
    <Svg>
      <path d="M4 4h16v11l-5 5H4z" />
      <path d="M20 15h-5v5" />
    </Svg>
  )
}
function FrameIcon() {
  return (
    <Svg>
      <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
    </Svg>
  )
}
function PencilIcon() {
  return (
    <Svg>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
    </Svg>
  )
}
function HighlightIcon() {
  return (
    <Svg>
      <path d="M15 4l5 5-8 8H7v-5z" />
      <path d="M4 21h8" />
    </Svg>
  )
}
function ArrowToolIcon() {
  return (
    <Svg>
      <line x1="5" y1="19" x2="19" y2="5" />
      <polyline points="9 5 19 5 19 15" />
    </Svg>
  )
}
function LineIcon() {
  return (
    <Svg>
      <line x1="5" y1="19" x2="19" y2="5" />
    </Svg>
  )
}
function EraserIcon() {
  return (
    <Svg>
      <path d="M15 4l5 5-8 8H8l-4-4z" />
      <path d="M8 21h12" />
    </Svg>
  )
}
function LaserIcon() {
  return (
    <Svg>
      <circle cx="12" cy="12" r="2.5" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M6 6l1.5 1.5M16.5 16.5 18 18M18 6l-1.5 1.5M7.5 16.5 6 18" />
    </Svg>
  )
}
function ShapesIcon() {
  return (
    <Svg>
      <rect x="3" y="11" width="9" height="9" rx="1.5" />
      <circle cx="16" cy="8" r="5" />
    </Svg>
  )
}

function GeoIcon({ geo }: { geo: string }) {
  return <Svg size={20}>{geoPath(geo)}</Svg>
}

function geoPath(geo: string): React.ReactNode {
  switch (geo) {
    case 'rectangle':
      return <rect x="4" y="6" width="16" height="12" rx="1.5" />
    case 'ellipse':
      return <ellipse cx="12" cy="12" rx="9" ry="6.5" />
    case 'triangle':
      return <path d="M12 4l9 16H3z" />
    case 'diamond':
      return <path d="M12 3l9 9-9 9-9-9z" />
    case 'pentagon':
      return <path d="M12 3l9 6.6-3.4 10.4H6.4L3 9.6z" />
    case 'hexagon':
      return <path d="M7.5 4h9l4.5 8-4.5 8h-9L3 12z" />
    case 'octagon':
      return <path d="M8 3h8l5 5v8l-5 5H8l-5-5V8z" />
    case 'star':
      return <path d="M12 3l2.6 6 6.4.5-4.9 4.2 1.6 6.3L12 16.8 6.3 20l1.6-6.3L3 9.5 9.4 9z" />
    case 'rhombus':
      return <path d="M8 5h12l-4 14H4z" />
    case 'rhombus-2':
      return <path d="M4 5h12l4 14H8z" />
    case 'oval':
      return <rect x="3" y="7" width="18" height="10" rx="5" />
    case 'trapezoid':
      return <path d="M7 6h10l4 12H3z" />
    case 'cloud':
      return <path d="M7 18h9a3.8 3.8 0 0 0 .6-7.6A5.4 5.4 0 0 0 5.8 9.2 3.6 3.6 0 0 0 7 18z" />
    case 'heart':
      return <path d="M12 20S3.5 14.5 3.5 8.8a4.3 4.3 0 0 1 8.5-1a4.3 4.3 0 0 1 8.5 1C20.5 14.5 12 20 12 20z" />
    case 'x-box':
      return (
        <>
          <rect x="4" y="4" width="16" height="16" rx="1.5" />
          <path d="M9 9l6 6M15 9l-6 6" />
        </>
      )
    case 'check-box':
      return (
        <>
          <rect x="4" y="4" width="16" height="16" rx="1.5" />
          <path d="M8 12.5l2.5 2.5 5-6" />
        </>
      )
    case 'arrow-right':
      return <path d="M4 10h8V6l8 6-8 6v-4H4z" />
    case 'arrow-left':
      return <path d="M20 10h-8V6l-8 6 8 6v-4h8z" />
    case 'arrow-up':
      return <path d="M10 20v-8H6l6-8 6 8h-4v8z" />
    case 'arrow-down':
      return <path d="M10 4v8H6l6 8 6-8h-4V4z" />
    default:
      return <rect x="4" y="6" width="16" height="12" rx="1.5" />
  }
}
