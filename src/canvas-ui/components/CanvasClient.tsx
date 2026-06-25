'use client'

import dynamic from 'next/dynamic'
import { useEffect } from 'react'
import Home from './Home'
import ProjectHeader from './ProjectHeader'
import TopBlur from './TopBlur'
import Sidebar from './Sidebar'
import { useRainyStore, type View } from '@/lib/store'
import { setActiveProject } from '@/lib/api'

// xterm touches the DOM on load; keep it out of the prerendered bundle.
const ClaudePanel = dynamic(() => import('./ClaudePanel'), { ssr: false })

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
  const claudeOpen = useRainyStore((s) => s.claudePanelOpen)
  const dark = useRainyStore((s) => s.dark)

  // Keep the URL hash and the navigation state in sync, both directions:
  // hash → state (deep links, refresh, back/forward) and state → hash.
  useEffect(() => {
    // Mirror the open project to the backend so the embedded Claude session and
    // its MCP tools default to "the project the user is looking at". Deduped so
    // we only POST on an actual change (the store fires on every UI mutation).
    let lastActive: string | null | undefined
    const syncActive = (id: string | null) => {
      if (id === lastActive) return
      lastActive = id
      void setActiveProject(id)
    }
    const activeFrom = (s: { view: View; currentProjectId: string | null }) =>
      s.view === 'canvas' ? s.currentProjectId : null

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
    syncActive(activeFrom(useRainyStore.getState()))

    const unsub = useRainyStore.subscribe((s) => {
      const want = s.view === 'canvas' && s.currentProjectId ? `#/p/${encodeURIComponent(s.currentProjectId)}` : '#/'
      // replaceState (not hashchange) → no feedback loop with the listener above.
      if (window.location.hash !== want) window.history.replaceState(null, '', want)
      syncActive(activeFrom(s))
    })

    return () => {
      window.removeEventListener('hashchange', fromHash)
      unsub()
    }
  }, [])

  // One persistent app shell wraps BOTH Home and the canvas. <ClaudePanel/> is a
  // constant sibling at the same child position in either branch, so React keeps
  // the single Claude session (websocket + PTY) mounted across every Home⇄canvas
  // and project→project switch — the conversation never resets on navigation.
  // `claude-open` lets the CSS reserve the right gutter on Home.
  const appClass = `rainy-app${dark ? ' dark' : ''}${claudeOpen ? ' claude-open' : ''}`

  if (view !== 'canvas' || !projectId) {
    return (
      <div className={appClass}>
        <Home />
        <ClaudePanel />
      </div>
    )
  }

  return (
    <div className={appClass}>
      <div className={`rainy-root${sidebarCollapsed ? ' sidebar-collapsed' : ''}${dark ? ' dark' : ''}`}>
        {/* key by project so switching projects fully remounts the canvas */}
        <CanvasWorkspace key={projectId} projectId={projectId} />
        <Sidebar />
        <TopBlur />
        <ProjectHeader />
      </div>
      {/* Same child index (1) as in the Home branch above → React preserves it
          across navigation instead of unmounting, so scrollback + the live
          conversation survive project switches. */}
      <ClaudePanel />
    </div>
  )
}
