'use client'

import { useRef } from 'react'
import { gsap } from 'gsap'
import { useIsoLayoutEffect } from '@/lib/useIso'

/** Empty glassy sidebar panel (contents intentionally removed for now). */
export default function Sidebar() {
  const ref = useRef<HTMLElement>(null)

  useIsoLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ctx = gsap.context(() => {
      gsap.from(el, { x: -16, autoAlpha: 0, duration: 0.5, ease: 'power3.out' })
    })
    return () => ctx.revert()
  }, [])

  return <aside className="rainy-sidebar" ref={ref} />
}
