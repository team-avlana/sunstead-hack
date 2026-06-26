'use client'

// The dashboard reads window/localStorage (hash routing) and is purely a backend
// client, so render it client-only — no SSR pass (matches CanvasClient's pattern).
import dynamic from 'next/dynamic'

const AgencyApp = dynamic(() => import('./AgencyApp'), {
  ssr: false,
  loading: () => <div style={{ position: 'fixed', inset: 0, background: '#f6f7fb' }} />,
})

export default function AgencyClient() {
  return <AgencyApp />
}
