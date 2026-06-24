'use client'

import { useRef } from 'react'
import { gsap } from 'gsap'
import { useIsoLayoutEffect } from '@/lib/useIso'
import { useRainyStore, type CommsStatus } from '@/lib/store'

const NAV = ['Canvas', 'Creators', 'Videos', 'Analyses']

const STATUS_LABEL: Record<CommsStatus, string> = {
  idle: 'Idle',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  mock: 'Rainey active',
}

export default function Sidebar() {
  const ref = useRef<HTMLElement>(null)
  const status = useRainyStore((s) => s.commsStatus)
  const selectedCount = useRainyStore((s) => s.selectedIds.length)

  useIsoLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ctx = gsap.context(() => {
      gsap.from(el, { x: -16, autoAlpha: 0, duration: 0.5, ease: 'power3.out' })
      gsap.from(el.querySelectorAll('.rainy-nav button, .rainy-project'), {
        x: -8, autoAlpha: 0, duration: 0.35, stagger: 0.04, delay: 0.12, ease: 'power2.out',
      })
    })
    return () => ctx.revert()
  }, [])

  return (
    <aside className="rainy-sidebar" ref={ref}>
      <div className="rainy-brand">
        <span className="dot" /> Rainy
      </div>

      <nav className="rainy-nav">
        {NAV.map((item, i) => (
          <button key={item} className={i === 0 ? 'active' : ''} type="button">
            {item}
          </button>
        ))}
      </nav>

      <div>
        <div className="rainy-section-title">Projects</div>
        <div className="rainy-projects">
          <button className="rainy-project active" type="button">Untitled board</button>
        </div>
      </div>

      <div className="rainy-spacer" />

      <div className="rainy-status">
        <span className={`led ${status}`} /> {STATUS_LABEL[status]} · {selectedCount} selected
      </div>
    </aside>
  )
}
