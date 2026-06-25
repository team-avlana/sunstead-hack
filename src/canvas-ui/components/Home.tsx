'use client'

import { useEffect, useRef, useState } from 'react'
import { gsap } from 'gsap'
import { createProject, deleteProject, listProjects, type ProjectMeta } from '@/lib/projects'
import { useIsoLayoutEffect } from '@/lib/useIso'
import { useRainyStore } from '@/lib/store'
import { useShootingConditions } from '@/lib/daylight'
import CreatorRoom from './CreatorRoom'

// No auth yet — the signed-in creator is hardcoded.
const USER_NAME = 'Adrian'

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
      gsap.from(el.children, { y: 12, autoAlpha: 0, duration: 0.45, stagger: 0.05, ease: 'power3.out', delay: 0.08 })
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
        <div className="home-brand">
          <RainyMark />
          <span>Rainey</span>
        </div>
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

          <div className="home-list" ref={listRef}>
            <button className="home-row home-row-new" onClick={onNew}>
              <span className="home-row-plus">+</span> New Project
            </button>

            {projects?.map((m) => (
              <button key={m.id} className="home-row" onClick={() => openProject(m.id, m.title)}>
                <span className="home-row-title">{m.title || 'Untitled project'}</span>
                <span className="home-row-del" role="button" title="Delete project" onClick={(e) => onDelete(m, e)}>
                  ×
                </span>
              </button>
            ))}

            {projects && projects.length === 0 && (
              <div className="home-empty">No projects yet — create your first one.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/** Golden hour + a few shoot-relevant weather readings under the greeting. */
function Conditions({ cond }: { cond: ReturnType<typeof useShootingConditions> }) {
  if (!cond.ready || !cond.golden) {
    return <p className="home-conditions home-conditions-loading">Checking the light…</p>
  }
  const w = cond.weather
  return (
    <div className="home-conditions">
      <span className="home-cond home-cond-golden">
        <strong>{cond.golden.label}</strong> {cond.golden.range}
      </span>
      {cond.location && (
        <span className="home-cond">
          <span className="home-cond-ico">📍</span>
          {cond.location.name}
          {!cond.location.precise && <span className="home-cond-approx"> · approx</span>}
        </span>
      )}
      {w ? (
        <span className="home-cond" title={`Feels like ${w.apparentC}° · Humidity ${w.humidity}%`}>
          <span className="home-cond-ico">{w.emoji}</span>
          {w.tempC}° · {w.condition} · ☁ {w.cloudCover}% · 💨 {w.windKph} km/h
        </span>
      ) : (
        <span className="home-cond home-cond-dim">Weather unavailable</span>
      )}
    </div>
  )
}

function RainyMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--ink)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 18a5 5 0 0 1-1-9.9A6 6 0 0 1 18 8a4 4 0 0 1 0 8" />
      <path d="M8 19v2M12 19v3M16 19v2" />
    </svg>
  )
}
