'use client'

import { useState } from 'react'

const ed = (): any => (typeof window !== 'undefined' ? (window as any).__rainyEditor : undefined)

export default function ZoomControls() {
  const [pct, setPct] = useState(100)
  const sync = () => {
    const z = ed()?.getZoomLevel?.()
    if (z) setPct(Math.round(z * 100))
  }
  return (
    <div className="rainy-zoom">
      <button type="button" title="Zoom out" onClick={() => { ed()?.zoomOut?.(); setTimeout(sync, 80) }}>−</button>
      <span className="pct" title="Reset" onClick={() => { ed()?.resetZoom?.(); setTimeout(sync, 80) }}>{pct}%</span>
      <button type="button" title="Zoom in" onClick={() => { ed()?.zoomIn?.(); setTimeout(sync, 80) }}>+</button>
    </div>
  )
}
