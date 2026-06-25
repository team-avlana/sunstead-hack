'use client'

import dynamic from 'next/dynamic'
import { useEffect } from 'react'
import Home from './Home'
import ProjectHeader from './ProjectHeader'
import TopBlur from './TopBlur'
import Sidebar from './Sidebar'
import { useRainyStore } from '@/lib/store'

// ssr:false is legal here because this file is a Client Component (App Router rule).
const CanvasWorkspace = dynamic(() => import('./CanvasWorkspace'), {
  ssr: false,
  loading: () => <div className="rainy-canvas" style={{ background: 'var(--canvas)' }} />,
})

/** `#/` → Home, `#/p/<projectId>` → that project's canvas. */
function projectIdFromHash(): string | null {
  const m = window.location.hash.match(/^#\/p\/(.+)$/)
  return m ? decodeURIComponent(m[1]) : null
}

export default function CanvasClient() {
  const view = useRainyStore((s) => s.view)
  const projectId = useRainyStore((s) => s.currentProjectId)
  const sidebarCollapsed = useRainyStore((s) => s.sidebarCollapsed)

  // Keep the URL hash and the navigation state in sync, both directions:
  // hash → state (deep links, refresh, back/forward) and state → hash.
  useEffect(() => {
    const fromHash = () => {
      const id = projectIdFromHash()
      const st = useRainyStore.getState()
      if (id) {
        if (st.view !== 'canvas' || st.currentProjectId !== id) st.openProject(id)
      } else if (st.view !== 'home') {
        st.goHome()
      }
    }
    fromHash()
    window.addEventListener('hashchange', fromHash)

    const unsub = useRainyStore.subscribe((s) => {
      const want = s.view === 'canvas' && s.currentProjectId ? `#/p/${encodeURIComponent(s.currentProjectId)}` : '#/'
      // replaceState (not hashchange) → no feedback loop with the listener above.
      if (window.location.hash !== want) window.history.replaceState(null, '', want)
    })

    return () => {
      window.removeEventListener('hashchange', fromHash)
      unsub()
    }
  }, [])

  if (view !== 'canvas' || !projectId) return <Home />

  return (
    <div className={`rainy-root${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
      {/* key by project so switching projects fully remounts the canvas */}
      <CanvasWorkspace key={projectId} projectId={projectId} />
      <Sidebar />
      <TopBlur />
      <ProjectHeader />
    </div>
  )
}
