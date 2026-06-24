'use client'

import { useRef } from 'react'
import { gsap } from 'gsap'
import { useIsoLayoutEffect } from '@/lib/useIso'

const ed = (): any => (typeof window !== 'undefined' ? (window as any).__rainyEditor : undefined)

export default function Header() {
  const ref = useRef<HTMLDivElement>(null)

  useIsoLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ctx = gsap.context(() => {
      gsap.from(el, { y: -14, autoAlpha: 0, duration: 0.5, ease: 'power3.out', delay: 0.05 })
    })
    return () => ctx.revert()
  }, [])

  return (
    <div className="rainy-header" ref={ref}>
      <div className="doc">
        <span className="led" /> Untitled board <span className="sub">· edited just now</span>
      </div>
      <div className="grow" />
      <button className="icon-btn" title="Undo" type="button" onClick={() => ed()?.undo?.()}>↺</button>
      <button className="icon-btn" title="Redo" type="button" onClick={() => ed()?.redo?.()}>↻</button>
      <button className="btn-primary" type="button">Share</button>
    </div>
  )
}
