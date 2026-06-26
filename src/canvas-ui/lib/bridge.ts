import type { Editor } from 'tldraw'
import { fitOrRecenter } from './camera'
import type { CanvasOp } from './remoteOps'

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

  // Swift -> JS: push a batch of agent ops onto the canvas. Lazy-load the op
  // applier so the eager landing bundle (Home → CreatorRoom only needs
  // `postNative`) never pulls remoteOps → all of tldraw. installBridge only
  // runs once the canvas is mounted, where tldraw is already loading.
  w.__rainyApplyOps = (ops: CanvasOp[]) => {
    void import('./remoteOps').then(({ applyRemoteOps }) => applyRemoteOps(editor, ops))
  }

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

  // Fit into the visible region (clear of the floating panels), with a guaranteed
  // recenter when the canvas is empty.
  const onZoomFit = () => fitOrRecenter(editor)
  window.addEventListener('native:zoomToFit', onZoomFit)

  return () => {
    window.removeEventListener('native:zoomToFit', onZoomFit)
    delete w.__rainyApplyOps
    delete w.__rainyNative
  }
}
