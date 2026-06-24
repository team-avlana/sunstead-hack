'use client'

import { useCallback } from 'react'
import { Tldraw, type Editor, type TLComponents } from 'tldraw'
import 'tldraw/tldraw.css'
import { installBridge } from '@/lib/bridge'
import { connectRealtime } from '@/lib/realtime'
import { startMockComms } from '@/lib/mockComms'
import { attachOutboundSync } from '@/lib/remoteOps'
import { useRainyStore } from '@/lib/store'

// Keep stock tldraw chrome for now; the "liquid glass" / branded chrome comes with the design system.
const components: TLComponents = {
  DebugPanel: null,
  DebugMenu: null,
}

export default function CanvasWorkspace() {
  const handleMount = useCallback((editor: Editor) => {
    ;(window as any).__rainyEditor = editor

    const disposers: Array<() => void> = [
      installBridge(editor),       // Swift <-> JS bridge + window.__rainyApplyOps
      connectRealtime(editor),     // SSE op stream (no-op until backend configured)
      startMockComms(editor),      // dev demo: agent drops a few nodes
      attachOutboundSync(editor),  // ship user edits back to the Comms Service
      // mirror selection into the app store for the sidebar
      editor.store.listen(
        () => useRainyStore.getState().setSelectedIds(editor.getSelectedShapeIds().map(String)),
        { scope: 'session' }
      ),
    ]

    return () => disposers.forEach((dispose) => dispose())
  }, [])

  return (
    <div className="rainy-canvas">
      <div style={{ position: 'absolute', inset: 0 }}>
        <Tldraw colorScheme="dark" components={components} onMount={handleMount} />
      </div>
    </div>
  )
}
