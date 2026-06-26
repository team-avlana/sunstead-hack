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
 * Reconnect uses capped exponential backoff (not a fixed 1.8s hammer) and the
 * poll self-schedules — fast while connected, slow while disconnected, paused
 * while the tab is hidden or the device is offline — so a backend that stays down
 * doesn't drain battery/network. Recovery is accelerated by the `online` and
 * `visibilitychange` events.
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
  let poll: number | undefined
  let attempt = 0

  const RETRY_BASE_MS = 1800
  const RETRY_MAX_MS = 30000
  const POLL_FAST_MS = 6000
  const POLL_SLOW_MS = 30000

  const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false
  const connected = () => ws?.readyState === WebSocket.OPEN

  const resync = () => {
    if (document.hidden) return // a hidden tab doesn't need to reconcile live
    window.clearTimeout(debounce)
    debounce = window.setTimeout(() => void syncBackendProject(editor, projectId), 200)
  }

  const scheduleRetry = () => {
    if (closed) return
    const delay = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS)
    attempt++
    retry = window.setTimeout(open, delay)
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
    ws.onopen = () => {
      attempt = 0
      useRainyStore.getState().setCommsStatus('connected')
      resync() // catch up on anything missed while disconnected
    }
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

  // Safety-net poll — self-scheduling so it can slow down when disconnected and
  // pause when hidden/offline, instead of a fixed interval that runs regardless.
  const tick = () => {
    if (closed) return
    if (!document.hidden && !isOffline()) void syncBackendProject(editor, projectId)
    poll = window.setTimeout(tick, connected() ? POLL_FAST_MS : POLL_SLOW_MS)
  }
  poll = window.setTimeout(tick, POLL_FAST_MS)

  // Recover fast when the network/tab comes back rather than waiting out a backoff.
  const onOnline = () => {
    if (closed) return
    attempt = 0
    window.clearTimeout(retry)
    if (!ws || ws.readyState > WebSocket.OPEN) open()
    else resync()
  }
  const onVisible = () => {
    if (closed || document.hidden) return
    if (!ws || ws.readyState > WebSocket.OPEN) {
      attempt = 0
      window.clearTimeout(retry)
      open()
    }
    resync()
  }
  window.addEventListener('online', onOnline)
  document.addEventListener('visibilitychange', onVisible)

  return () => {
    closed = true
    window.clearTimeout(retry)
    window.clearTimeout(debounce)
    window.clearTimeout(poll)
    window.removeEventListener('online', onOnline)
    document.removeEventListener('visibilitychange', onVisible)
    try {
      ws?.close()
    } catch {
      /* ignore */
    }
  }
}

/**
 * Subscribe to change-signals for a SINGLE video (`/ws?video_id=…`). The backend
 * pushes one signal per analysis stage transition + on done/error, so a local
 * Video Block can update live instead of polling GET /api/videos/{id}. `onSignal`
 * fires on every message (the caller re-pulls the view-model). Reconnects with
 * capped backoff; returns a cleanup that closes the socket. No-op without a backend.
 */
export function subscribeVideoSignal(videoId: string, onSignal: () => void): () => void {
  if (typeof window === 'undefined' || !hasBackend()) return () => {}

  let closed = false
  let ws: WebSocket | null = null
  let retry: number | undefined
  let attempt = 0
  const RETRY_BASE_MS = 1500
  const RETRY_MAX_MS = 15000

  const scheduleRetry = () => {
    if (closed) return
    const delay = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS)
    attempt++
    retry = window.setTimeout(open, delay)
  }

  function open() {
    const base = wsBase()
    if (!base || closed) return
    try {
      ws = new WebSocket(`${base}/ws?video_id=${encodeURIComponent(videoId)}`)
    } catch {
      scheduleRetry()
      return
    }
    ws.onopen = () => {
      attempt = 0
    }
    ws.onmessage = () => onSignal()
    ws.onerror = () => {
      try {
        ws?.close()
      } catch {
        /* ignore */
      }
    }
    ws.onclose = () => {
      ws = null
      if (!closed) scheduleRetry()
    }
  }

  open()

  return () => {
    closed = true
    window.clearTimeout(retry)
    try {
      ws?.close()
    } catch {
      /* ignore */
    }
  }
}
