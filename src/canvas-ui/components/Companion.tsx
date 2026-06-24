'use client'

import { useCallback, useRef, useState } from 'react'

/**
 * Rainey — the companion (PLACEHOLDER).
 * A draggable red reindeer that will eventually follow you around and help you edit
 * (see ../../../docs/COMPANION.md). The real companion is a native mac-app overlay;
 * this is just an in-app stub so the running shell shows the concept. Visual design TBD.
 */
export default function Companion() {
  const [pos, setPos] = useState({ right: 28, bottom: 24 })
  const [dragging, setDragging] = useState(false)
  const [open, setOpen] = useState(false)
  const moved = useRef(false)

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
      setDragging(true)
      moved.current = false
      const startX = e.clientX
      const startY = e.clientY
      const start = { ...pos }

      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - startX
        const dy = ev.clientY - startY
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved.current = true
        setPos({
          right: Math.max(8, start.right - dx),
          bottom: Math.max(8, start.bottom - dy),
        })
      }
      const onUp = () => {
        setDragging(false)
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [pos]
  )

  const onClick = useCallback(() => {
    if (!moved.current) setOpen((o) => !o)
  }, [])

  return (
    <div
      className={`rainey${dragging ? ' dragging' : ''}`}
      style={{ right: pos.right, bottom: pos.bottom }}
      onPointerDown={onPointerDown}
      onClick={onClick}
      title="Rainey — your companion (coming soon)"
    >
      {open && (
        <div className="rainey-bubble">
          Hi, I&rsquo;m <strong>Rainey</strong> 🦌 — I&rsquo;ll ride along and help you edit: spot
          outliers, draft ideas, and point at things on screen. <em>(companion coming soon)</em>
        </div>
      )}
      <RaineyMark />
    </div>
  )
}

function RaineyMark() {
  // Placeholder red reindeer-nose character. Full mark lives in design/index.html.
  return (
    <svg
      className="rainey-body"
      width="72"
      height="72"
      viewBox="0 0 72 72"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Rainey"
    >
      {/* antlers */}
      <path d="M24 16c-4-3-6-8-5-12M48 16c4-3 6-8 5-12" stroke="#d24b3f" strokeWidth="3" strokeLinecap="round" />
      {/* body */}
      <rect x="14" y="16" width="44" height="40" rx="12" fill="#d24b3f" />
      {/* visor */}
      <rect x="22" y="30" width="28" height="11" rx="3" fill="#ffffff" />
      {/* red nose */}
      <circle cx="36" cy="58" r="5" fill="#e0564a" stroke="#b23a30" strokeWidth="2" />
    </svg>
  )
}
