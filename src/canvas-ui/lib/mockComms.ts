import type { Editor } from 'tldraw'
import { applyRemoteOps } from './remoteOps'
import { useRainyStore } from './store'

/**
 * Dev-only demo: simulates the Comms Service "pinging" the canvas with agent-authored nodes,
 * so the agent -> canvas path is visible end-to-end with NO backend running.
 * Disabled when a real SSE URL is configured or in production.
 */
export function startMockComms(editor: Editor): () => void {
  if (typeof window === 'undefined') return () => {}
  if (process.env.NEXT_PUBLIC_COMMS_SSE_URL) return () => {}
  if (process.env.NODE_ENV === 'production') return () => {}

  const t = window.setTimeout(() => {
    try {
      applyRemoteOps(editor, [
        { kind: 'addNode', id: 'demo-1', shapeType: 'note', x: 140, y: 160 },
        { kind: 'addNode', id: 'demo-2', shapeType: 'note', x: 460, y: 240 },
        { kind: 'addNode', id: 'demo-3', shapeType: 'note', x: 280, y: 460 },
      ])
      useRainyStore.getState().setCommsStatus('mock')
    } catch (err) {
      console.warn('[rainy] mock comms failed', err)
    }
  }, 1200)

  return () => window.clearTimeout(t)
}
