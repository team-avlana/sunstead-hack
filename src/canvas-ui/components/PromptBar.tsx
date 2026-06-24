'use client'

import { useRef } from 'react'
import { gsap } from 'gsap'
import { useIsoLayoutEffect } from '@/lib/useIso'

export default function PromptBar() {
  const ref = useRef<HTMLDivElement>(null)

  useIsoLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ctx = gsap.context(() => {
      gsap.from(el, { y: 18, autoAlpha: 0, duration: 0.55, ease: 'power3.out', delay: 0.15 })
    })
    return () => ctx.revert()
  }, [])

  return (
    <div className="rainy-prompt" ref={ref}>
      <span className="rainey-avatar" aria-label="Rainey">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="5" y="6" width="14" height="12" rx="4" fill="#fff" />
          <rect x="8" y="10" width="8" height="3.4" rx="1.5" fill="#3b6ef6" />
        </svg>
      </span>
      <input placeholder="Ask Rainey to compare these, find the hook pattern…" />
      <span className="kbd">⌘K</span>
      <button className="send-btn" title="Send" type="button">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 19V5M12 5l-6 6M12 5l6 6" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  )
}
