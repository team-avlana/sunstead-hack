'use client'

import { useEffect, useRef, useState } from 'react'
import { gsap } from 'gsap'
import { createProject, deleteProject, listProjects, type ProjectMeta } from '@/lib/projects'
import { useIsoLayoutEffect } from '@/lib/useIso'
import { useRainyStore } from '@/lib/store'
import { useShootingConditions } from '@/lib/daylight'
import CreatorRoom from './CreatorRoom'

// No auth yet — the signed-in creator is hardcoded.
const USER_NAME = 'Matthias'

/** Home — greeting + shooting conditions, the Creator Room, and the project list. */
export default function Home() {
  const openProject = useRainyStore((s) => s.openProject)
  const [projects, setProjects] = useState<ProjectMeta[] | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const cond = useShootingConditions()

  const refresh = () => listProjects().then(setProjects).catch(() => setProjects([]))
  useEffect(() => {
    refresh()
  }, [])

  useIsoLayoutEffect(() => {
    if (!projects) return
    const el = listRef.current
    if (!el) return
    const ctx = gsap.context(() => {
      gsap.from('.home-topbar > *, .home-greeting > *', { y: 10, autoAlpha: 0, duration: 0.5, stagger: 0.06, ease: 'power3.out' })
      gsap.from('.home-room', { y: 14, autoAlpha: 0, duration: 0.5, ease: 'power3.out' })
      gsap.from('.home-projects-head', { y: 12, autoAlpha: 0, duration: 0.5, ease: 'power3.out', delay: 0.05 })
      gsap.from(el.children, { y: 12, autoAlpha: 0, duration: 0.45, stagger: 0.05, ease: 'power3.out', delay: 0.12 })
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
      <header className="home-topbar">
        <div className="home-brand">Rainey</div>
        <div className="home-avatar" title={USER_NAME} aria-label={USER_NAME}>
          {USER_NAME.charAt(0)}
        </div>
      </header>

      <div className="home-main">
        <div className="home-room">
          <CreatorRoom />
        </div>

        <div className="home-side">
          <div className="home-greeting">
            <h1>
              {cond.ready ? cond.greeting : 'Hello'}, {USER_NAME}
            </h1>
            <Conditions cond={cond} />
          </div>

          <div className="home-projects">
            <div className="home-projects-head">
              <span className="home-projects-title">Projects</span>
              <button className="home-new" onClick={onNew}>
                <span className="home-new-plus">+</span> New
              </button>
            </div>

            <div className="home-grid" ref={listRef}>
              {projects?.map((m) => (
                <button key={m.id} className="home-card" onClick={() => openProject(m.id, m.title)}>
                  <span className="home-card-title">{m.title || 'Untitled project'}</span>
                  <span className="home-card-meta">{m.blocks} block{m.blocks === 1 ? '' : 's'}</span>
                  <span className="home-card-del" role="button" title="Delete project" onClick={(e) => onDelete(m, e)}>
                    ×
                  </span>
                </button>
              ))}

              {projects && projects.length === 0 && (
                <button className="home-card home-card-empty" onClick={onNew}>
                  <span className="home-card-title">Create your first project</span>
                  <span className="home-card-meta">Start a new canvas</span>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Golden hour + shoot conditions as one quiet, single line under the greeting. */
function Conditions({ cond }: { cond: ReturnType<typeof useShootingConditions> }) {
  if (!cond.ready || !cond.golden) {
    return <p className="home-conditions">Checking the light…</p>
  }
  const w = cond.weather
  return (
    <p className="home-conditions">
      <span className="home-cond home-cond-golden">
        <SunGlyph />
        {cond.golden.label} {cond.golden.range}
      </span>
      {cond.location && (
        <>
          <span className="home-cond-sep" aria-hidden>·</span>
          <span className="home-cond">
            {cond.location.name}
            {!cond.location.precise && ' · approx'}
          </span>
        </>
      )}
      {w && (
        <>
          <span className="home-cond-sep" aria-hidden>·</span>
          <span className="home-cond" title={`Feels like ${w.apparentC}° · Humidity ${w.humidity}%`}>
            {w.emoji} {w.tempC}° {w.condition}
          </span>
        </>
      )}
    </p>
  )
}

/** Small, muted sun mark for the golden-hour line. */
function SunGlyph() {
  return (
    <svg className="home-sun" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v1.5M12 19.5V21M4.2 4.2l1 1M18.8 18.8l1 1M3 12h1.5M19.5 12H21M4.2 19.8l1-1M18.8 5.2l1-1" />
    </svg>
  )
}
