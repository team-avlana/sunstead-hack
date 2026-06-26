'use client'

/**
 * App Router segment error boundary. Next.js auto-wraps the page subtree
 * (CanvasClient + all chrome + the dynamically-imported CanvasWorkspace) in this,
 * so an uncaught render/mount throw shows a branded recover card instead of a blank
 * white screen. Recovery is manual (a button) to avoid a reset→re-throw loop on a
 * deterministic error; "Go home" clears the open project so a per-project crash is
 * always escapable.
 */

import { useEffect } from 'react'
import { useRainyStore } from '@/lib/store'

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error('[rainy] canvas crashed:', error)
  }, [error])

  const goHome = () => {
    try {
      useRainyStore.getState().goHome()
    } catch {
      /* ignore */
    }
    reset()
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'grid',
        placeItems: 'center',
        background: 'var(--canvas, #f4f6fb)',
        zIndex: 9999,
        fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif",
        color: 'var(--ink, #191d28)',
      }}
    >
      <div style={{ textAlign: 'center', maxWidth: 380, padding: '0 24px' }}>
        <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 8 }}>Something went wrong on the canvas</div>
        <div style={{ fontSize: 13, opacity: 0.6, marginBottom: 22, lineHeight: 1.5 }}>
          Your work is saved. Reload the canvas to continue, or head back to your projects.
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
          <button onClick={() => reset()} style={btn(true)}>
            Reload canvas
          </button>
          <button onClick={goHome} style={btn(false)}>
            Go home
          </button>
        </div>
      </div>
    </div>
  )
}

function btn(primary: boolean): React.CSSProperties {
  return {
    appearance: 'none',
    border: primary ? 'none' : '1px solid rgba(18,24,48,0.14)',
    background: primary ? 'var(--primary, #5b6cff)' : 'transparent',
    color: primary ? '#fff' : 'inherit',
    font: 'inherit',
    fontWeight: 500,
    fontSize: 13,
    padding: '9px 16px',
    borderRadius: 10,
    cursor: 'pointer',
  }
}
