import type { Editor } from 'tldraw'
import { applyRemoteOps, type CanvasOp } from './remoteOps'
import { useRainyStore } from './store'

/**
 * SSE client for the Comms Service op stream (scaffold).
 *
 * NOTE: the canonical design (docs/architecture.md) uses a WEBSOCKET "change-signal" + the canvas
 * re-pulling from Postgres — not SSE carrying ops. This is a divergence to reconcile
 * (docs/INTEGRATION_NOTES.md #2). No-op until NEXT_PUBLIC_COMMS_SSE_URL is set.
 */
export function connectRealtime(editor: Editor): () => void {
  if (typeof window === 'undefined') return () => {}
  const url = process.env.NEXT_PUBLIC_COMMS_SSE_URL
  if (!url) return () => {}

  const es = new EventSource(url, { withCredentials: true })
  const onOps = (e: MessageEvent) => {
    try {
      applyRemoteOps(editor, JSON.parse(e.data) as CanvasOp[])
    } catch (err) {
      console.warn('[rainy] bad ops payload', err)
    }
  }
  es.addEventListener('ops', onOps as EventListener)
  es.addEventListener('open', () => useRainyStore.getState().setCommsStatus('connected'))
  es.addEventListener('error', () => useRainyStore.getState().setCommsStatus('reconnecting'))

  return () => es.close()
}
