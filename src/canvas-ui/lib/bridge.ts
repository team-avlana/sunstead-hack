import type { Editor } from 'tldraw'
import { applyRemoteOps, type CanvasOp } from './remoteOps'

/** JS -> Swift (fire-and-forget). No-op in a plain browser. */
export function postNative(msg: unknown): void {
  if (typeof window === 'undefined') return
  const native = (window as any).webkit?.messageHandlers?.rainy
  native?.postMessage(msg)
}

/**
 * Wire the JS <-> Swift bridge for the WKWebView shell. Returns a disposer.
 * See ../../../knowledge-base/architecture-patterns/webview-shell-and-data-path.md §2.
 */
export function installBridge(editor: Editor): () => void {
  if (typeof window === 'undefined') return () => {}
  const w = window as any

  // Swift -> JS: push a batch of agent ops onto the canvas.
  w.__rainyApplyOps = (ops: CanvasOp[]) => applyRemoteOps(editor, ops)

  // Swift -> JS: generic event receiver -> dispatches `native:<event>`.
  w.__rainyNative = {
    receive(payloadJson: string, event: string) {
      try {
        window.dispatchEvent(new CustomEvent(`native:${event}`, { detail: JSON.parse(payloadJson) }))
      } catch {
        /* ignore malformed payloads */
      }
    },
  }

  const onZoomFit = () => editor.zoomToFit()
  window.addEventListener('native:zoomToFit', onZoomFit)

  return () => {
    window.removeEventListener('native:zoomToFit', onZoomFit)
    delete w.__rainyApplyOps
    delete w.__rainyNative
  }
}
