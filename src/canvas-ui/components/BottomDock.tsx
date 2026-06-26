'use client'

import { createShapeId, useEditor, useValue, type Editor } from 'tldraw'
import { RAINY_TEXT, VIDEO_BLOCK, getDefaultTextFormat, templateHtml } from '@/lib/blockTypes'
import { fitOrRecenter, formatZoom, resetZoom, zoomInStep, zoomOutStep } from '@/lib/camera'
import { useRainyStore } from '@/lib/store'

/**
 * Bottom dock — the primary way to add blocks to the canvas.
 *
 * Two kinds of buttons:
 *   - **insert** shapes (Text/Video/Frame) drop a shape at the viewport centre
 *     and select it — immediate, like the original Text card.
 *   - **tool** buttons (Hand/Select) activate the matching built-in tldraw tool;
 *     the active one is highlighted.
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
  // Seed with the last-picked format's structure so the card opens pre-shaped.
  const html = templateHtml(getDefaultTextFormat())
  editor.run(() => {
    // x/y is the top-left; nudge by half the default size (360×332) so the card lands centered.
    editor.createShape({ id, type: RAINY_TEXT, x: c.x - 180, y: c.y - 166, props: { html } })
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

const createFrame = (editor: Editor) => createCentered(editor, 'frame', 420, 300, { w: 420, h: 300 })

// ---- tool tables ----------------------------------------------------------

type Tool = { id: string; label: string; icon: React.ReactNode }

// Built-in tldraw tools, grouped for the bar. `id` is the tldraw tool id.
const NAV: Tool[] = [
  { id: 'select', label: 'Select', icon: <SelectIcon /> },
  { id: 'hand', label: 'Hand (pan)', icon: <HandIcon /> },
]

// ---- dock -----------------------------------------------------------------

export default function BottomDock() {
  const editor = useEditor()
  const tool = useValue('currentTool', () => editor.getCurrentToolId(), [editor])
  const zoom = useValue('zoom', () => editor.getZoomLevel(), [editor])
  const empty = useValue('empty', () => editor.getCurrentPageShapeIds().size === 0, [editor])
  const dark = useRainyStore((s) => s.dark)
  const toggleDark = useRainyStore((s) => s.toggleDark)
  const loaded = useRainyStore((s) => s.loadState === 'ok')

  return (
    <>
      {/* First-run empty-state hint — only once the project has loaded with no
          blocks (so it never flashes during load and hides the instant a block
          appears). The backdrop is click-through; only the CTAs are interactive. */}
      {loaded && empty && (
        <div className="rainy-empty">
          <div className="rainy-empty-card" onPointerDown={(e) => e.stopPropagation()}>
            <div className="rainy-empty-title">Your canvas is ready</div>
            <div className="rainy-empty-sub">Add a block to start, or ask Rainy to bring in a video.</div>
            <div className="rainy-empty-cta">
              <button onClick={() => createTextCard(editor)}>
                <TextIcon /> Text
              </button>
              <button onClick={() => createVideoBlock(editor)}>
                <VideoIcon /> Video
              </button>
              <button onClick={() => createFrame(editor)}>
                <FrameIcon /> Frame
              </button>
            </div>
          </div>
        </div>
      )}

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
        <button className="rainy-tool" onClick={() => createFrame(editor)} title="Frame">
          <FrameIcon />
        </button>
        <span className="rainy-dock-sep" />

        {/* zoom + recover — the always-available way back to your content */}
        <button className="rainy-tool" onClick={() => zoomOutStep(editor)} title="Zoom out">
          <MinusIcon />
        </button>
        <button
          className="rainy-tool rainy-zoom"
          onClick={() => resetZoom(editor)}
          title="Reset to 100%"
        >
          {formatZoom(zoom)}
        </button>
        <button className="rainy-tool" onClick={() => zoomInStep(editor)} title="Zoom in">
          <PlusIcon />
        </button>
        <button className="rainy-tool" onClick={() => fitOrRecenter(editor)} title="Zoom to fit / recenter">
          <FitIcon />
        </button>
        <span className="rainy-dock-sep" />

        {/* dark mode */}
        <button
          className={`rainy-tool${dark ? ' on' : ''}`}
          onClick={() => toggleDark()}
          title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {dark ? <MoonIcon /> : <SunIcon />}
        </button>
      </div>
    </>
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
function FrameIcon() {
  return (
    <Svg>
      <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
    </Svg>
  )
}
function SunIcon() {
  return (
    <Svg>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </Svg>
  )
}
function MoonIcon() {
  return (
    <Svg>
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </Svg>
  )
}
function MinusIcon() {
  return (
    <Svg>
      <path d="M5 12h14" />
    </Svg>
  )
}
function PlusIcon() {
  return (
    <Svg>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  )
}
function FitIcon() {
  return (
    <Svg>
      <path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4" />
    </Svg>
  )
}
