'use client'

import { useCallback } from 'react'
import { Tldraw, type Editor, type TLComponents } from 'tldraw'
import 'tldraw/tldraw.css'
import { installBridge } from '@/lib/bridge'
import { connectRealtime } from '@/lib/realtime'
import { startMockComms } from '@/lib/mockComms'
import { attachOutboundSync } from '@/lib/remoteOps'
import { useRainyStore } from '@/lib/store'

// Clean canvas: hide stock tldraw chrome — we provide our own (sidebar, header, prompt bar).
const components: TLComponents = {
  Toolbar: null,
  MainMenu: null,
  PageMenu: null,
  StylePanel: null,
  NavigationPanel: null,
  ZoomMenu: null,
  QuickActions: null,
  ActionsMenu: null,
  HelpMenu: null,
  HelperButtons: null,
  DebugPanel: null,
  DebugMenu: null,
  Minimap: null,
  MenuPanel: null,
  TopPanel: null,
}

export default function CanvasWorkspace() {
  const handleMount = useCallback((editor: Editor) => {
    ;(window as any).__rainyEditor = editor
    editor.updateInstanceState({ isGridMode: true })

    const disposers: Array<() => void> = [
      installBridge(editor),
      connectRealtime(editor),
      startMockComms(editor),
      attachOutboundSync(editor),
      editor.store.listen(
        () => useRainyStore.getState().setSelectedIds(editor.getSelectedShapeIds().map(String)),
        { scope: 'session' }
      ),
    ]
    return () => disposers.forEach((dispose) => dispose())
  }, [])

  return (
    <div className="rainy-canvas">
      <Tldraw colorScheme="light" components={components} onMount={handleMount} />
    </div>
  )
}
