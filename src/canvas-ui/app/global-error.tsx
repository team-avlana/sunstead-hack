'use client'

/**
 * Root error boundary — catches throws in the RootLayout itself (which the
 * segment error.tsx cannot). It REPLACES the layout, so it must render its own
 * <html>/<body> and can't rely on app CSS being present → fully inline-styled.
 */

import { useEffect } from 'react'

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error('[rainy] fatal:', error)
  }, [error])

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          background: '#f4f6fb',
          fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif",
          color: '#191d28',
        }}
      >
        <div style={{ textAlign: 'center', maxWidth: 380, padding: '0 24px' }}>
          <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 8 }}>The app hit an unexpected error</div>
          <div style={{ fontSize: 13, opacity: 0.6, marginBottom: 22, lineHeight: 1.5 }}>
            Reloading usually fixes it. If it keeps happening, restart the app.
          </div>
          <button
            onClick={() => reset()}
            style={{
              appearance: 'none',
              border: 'none',
              background: '#5b6cff',
              color: '#fff',
              font: 'inherit',
              fontWeight: 500,
              fontSize: 13,
              padding: '9px 18px',
              borderRadius: 10,
              cursor: 'pointer',
            }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  )
}
