'use client'

import { useEffect, useRef, useState } from 'react'
import { gsap } from 'gsap'
import { createProject, deleteProject, listProjects, type ProjectMeta } from '@/lib/projects'
import { useIsoLayoutEffect } from '@/lib/useIso'
import { useRainyStore } from '@/lib/store'
import CreatorRoom from './CreatorRoom'

/** Home — the project picker. Each project opens its own infinite canvas. */
export default function Home() {
  const openProject = useRainyStore((s) => s.openProject)
  const [projects, setProjects] = useState<ProjectMeta[] | null>(null)
  const gridRef = useRef<HTMLDivElement>(null)

  const refresh = () => listProjects().then(setProjects).catch(() => setProjects([]))
  useEffect(() => {
    refresh()
  }, [])

  useIsoLayoutEffect(() => {
    if (!projects) return
    const el = gridRef.current
    if (!el) return
    const ctx = gsap.context(() => {
      gsap.from('.home-brand, .home-head > *', { y: 10, autoAlpha: 0, duration: 0.5, stagger: 0.06, ease: 'power3.out' })
      gsap.from(el.children, { y: 14, autoAlpha: 0, duration: 0.45, stagger: 0.045, ease: 'power3.out', delay: 0.05 })
    })
    return () => ctx.revert()
  }, [projects])

  const onNew = () => {
    const p = createProject('Untitled project')
    openProject(p.id, p.title)
  }

  const onDelete = (m: ProjectMeta, e: React.MouseEvent) => {
    e.stopPropagation()
    if (window.confirm(`Delete "${m.title}"? This can't be undone.`)) {
      deleteProject(m.id)
      refresh()
    }
  }

  return (
    <div className="home">
      <div className="home-inner">
        <div className="home-brand">
          <RainyMark />
          <span>Rainy</span>
        </div>

        <CreatorRoom />

        <div className="home-head">
          <h1>Your projects</h1>
          <p>Pick up where you left off, or start something new — every project is its own infinite canvas.</p>
        </div>

        <div className="home-grid" ref={gridRef}>
          <button className="home-card home-new" onClick={onNew}>
            <span className="home-new-plus">+</span>
            <span className="home-new-label">New project</span>
          </button>

          {projects?.map((m) => (
            <button key={m.id} className="home-card" onClick={() => openProject(m.id, m.title)}>
              <span className="home-card-del" role="button" title="Delete project" onClick={(e) => onDelete(m, e)}>
                ×
              </span>
              <span className="home-card-thumb">
                <CanvasGlyph />
              </span>
              <span className="home-card-title">{m.title || 'Untitled project'}</span>
              <span className="home-card-meta">
                {m.blocks} {m.blocks === 1 ? 'block' : 'blocks'} · {formatDate(m.updated)}
              </span>
            </button>
          ))}

          {projects && projects.length === 0 && <div className="home-empty">No projects yet — create your first one.</div>}
        </div>
      </div>
    </div>
  )
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function RainyMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 18a5 5 0 0 1-1-9.9A6 6 0 0 1 18 8a4 4 0 0 1 0 8" />
      <path d="M8 19v2M12 19v3M16 19v2" />
    </svg>
  )
}

function CanvasGlyph() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="7" height="6" rx="1.4" />
      <rect x="13" y="4" width="8" height="9" rx="1.4" />
      <rect x="3" y="13" width="7" height="7" rx="1.4" />
      <rect x="13" y="16" width="8" height="4" rx="1.4" />
    </svg>
  )
}
