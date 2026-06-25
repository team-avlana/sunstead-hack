'use client'

import { useEffect, useRef, useState } from 'react'
import { gsap } from 'gsap'
import { useIsoLayoutEffect } from '@/lib/useIso'
import { useRainyStore } from '@/lib/store'

const ed = (): any => (typeof window !== 'undefined' ? (window as any).__rainyEditor : undefined)

/** Live zoom percentage, polled per frame from the global editor. */
function useZoomPct(): number | null {
  const [pct, setPct] = useState<number | null>(null)
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const e = ed()
      if (e) {
        const p = Math.round(e.getZoomLevel() * 100)
        setPct((prev) => (prev === p ? prev : p))
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])
  return pct
}

export default function Sidebar() {
  const ref = useRef<HTMLElement>(null)
  const pct = useZoomPct()
  const collapsed = useRainyStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useRainyStore((s) => s.toggleSidebar)

  // Intro animation (runs once on mount). Kept inside a gsap.context so it's
  // scoped/reverted cleanly and never clobbers the collapse tween below.
  useIsoLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ctx = gsap.context(() => {
      gsap.from(el, { x: -16, autoAlpha: 0, duration: 0.5, ease: 'power3.out' })
      gsap.from(el.querySelectorAll('.ci-zoom, .ci-actions, .ci-hint'), {
        y: 8, autoAlpha: 0, duration: 0.35, stagger: 0.05, delay: 0.1, ease: 'power2.out',
      })
    })
    return () => ctx.revert()
  }, [])

  // Collapse / expand. GSAP must own this: the intro above leaves an inline
  // `transform` on the <aside>, and an inline transform beats any stylesheet
  // rule — so a CSS-class approach silently does nothing. Animating the same
  // inline transform here is what actually slides the panel, smoothly both ways.
  const firstRun = useRef(true)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    // Skip the initial render so the intro animation plays uninterrupted.
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

  return (
    <>
      <aside className="rainy-sidebar" ref={ref}>
      <div className="ci">
        <div className="ci-head">
          <div className="ci-title">Canvas</div>
          <button type="button" className="ci-collapse" title="Hide sidebar" aria-label="Hide sidebar" onClick={toggleSidebar}>
            <SidebarIcon size={18} />
          </button>
        </div>

        <div className="ci-zoom">
          <button type="button" title="Zoom out" onClick={() => ed()?.zoomOut?.()}>−</button>
          <button type="button" className="ci-zoom-pct" title="Reset to 100%" onClick={() => ed()?.resetZoom?.()}>
            {pct == null ? '100%' : `${pct}%`}
          </button>
          <button type="button" title="Zoom in" onClick={() => ed()?.zoomIn?.()}>+</button>
        </div>

        <div className="ci-actions">
          <button type="button" onClick={() => ed()?.zoomToFit?.()}>Zoom to fit</button>
          <button type="button" onClick={() => ed()?.setCamera?.({ x: 0, y: 0, z: 1 }, { animation: { duration: 250 } })}>
            Reset view
          </button>
        </div>

        <div className="ci-hint">Pan, scroll, or pinch to move around the canvas.</div>
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
