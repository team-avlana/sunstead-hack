'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { updateProjectTitle } from '@/lib/projects'
import { useRainyStore } from '@/lib/store'

/**
 * Floating canvas header — a circular chevron-back button (→ Home) plus the
 * editable project title. Sits over the canvas, just right of the sidebar.
 */
export default function ProjectHeader() {
  const id = useRainyStore((s) => s.currentProjectId)
  const title = useRainyStore((s) => s.currentProjectTitle)
  const setTitle = useRainyStore((s) => s.setTitle)
  const goHome = useRainyStore((s) => s.goHome)

  const [draft, setDraft] = useState(title)
  useEffect(() => setDraft(title), [title])

  // Auto-size the title input to its content so the full title shows (clamped to
  // max-width in CSS). An off-screen mirror measures the rendered text width.
  const mirrorRef = useRef<HTMLSpanElement>(null)
  const [width, setWidth] = useState<number | undefined>(undefined)
  useLayoutEffect(() => {
    if (mirrorRef.current) setWidth(mirrorRef.current.offsetWidth + 2)
  }, [draft])

  const commit = () => {
    const next = draft.trim() || 'Untitled project'
    setDraft(next)
    setTitle(next)
    if (id) void updateProjectTitle(id, next)
  }

  return (
    <header className="rainy-project-header">
      <button className="rph-back" onClick={goHome} title="Back to home" aria-label="Back to home">
        <ChevronLeft />
      </button>
      <span ref={mirrorRef} className="rph-title rph-title-mirror" aria-hidden>
        {draft || 'Untitled project'}
      </span>
      <input
        className="rph-title"
        style={{ width }}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') {
            setDraft(title)
            ;(e.target as HTMLInputElement).blur()
          }
        }}
        spellCheck={false}
        aria-label="Project title"
        placeholder="Untitled project"
      />
    </header>
  )
}

function ChevronLeft() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m15 18-6-6 6-6" />
    </svg>
  )
}
