import type { Editor } from 'tldraw'
import { hasBackend, isBackendId, wsBase } from './api'
import { syncBackendProject } from './backendCanvas'
import { useRainyStore } from './store'

/**
 * Realtime for a backend project: a websocket carrying a *change-signal only*
 * (never data) — on any signal the canvas re-pulls the project's artifacts from
 * Postgres and reconciles (docs/architecture.md, INTEGRATION_NOTES.md #2). A
 * gentle visibility-aware poll covers any missed signal.
 *
 * No-op for local (XML/localStorage) projects or when no backend is configured.
 */
export function connectRealtime(editor: Editor, projectId: string): () => void {
  if (typeof window === 'undefined') return () => {}
  if (!hasBackend() || !isBackendId(projectId)) {
    useRainyStore.getState().setCommsStatus('mock')
    return () => {}
  }

  let closed = false
  let ws: WebSocket | null = null
  let retry: number | undefined
  let debounce: number | undefined

  const resync = () => {
    window.clearTimeout(debounce)
    debounce = window.setTimeout(() => void syncBackendProject(editor, projectId), 200)
  }

  const scheduleRetry = () => {
    if (!closed) retry = window.setTimeout(open, 1800)
  }

  function open() {
    const base = wsBase()
    if (!base || closed) return
    try {
      ws = new WebSocket(`${base}/ws?project_id=${encodeURIComponent(projectId)}`)
    } catch {
      scheduleRetry()
      return
    }
    ws.onopen = () => useRainyStore.getState().setCommsStatus('connected')
    ws.onmessage = () => resync()
    ws.onerror = () => {
      try {
        ws?.close()
      } catch {
        /* ignore */
      }
    }
    ws.onclose = () => {
      ws = null
      if (!closed) {
        useRainyStore.getState().setCommsStatus('reconnecting')
        scheduleRetry()
      }
    }
  }

  open()

  // Safety-net poll — cheap for a handful of artifacts; pauses when hidden.
  const poll = window.setInterval(() => {
    if (!document.hidden) void syncBackendProject(editor, projectId)
  }, 6000)

  return () => {
    closed = true
    window.clearTimeout(retry)
    window.clearTimeout(debounce)
    window.clearInterval(poll)
    try {
      ws?.close()
    } catch {
      /* ignore */
    }
  }
}
