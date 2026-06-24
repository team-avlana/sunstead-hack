'use client'

import dynamic from 'next/dynamic'
import Sidebar from './Sidebar'
import Companion from './Companion'

// ssr:false is legal here because this file is a Client Component (App Router rule).
const CanvasWorkspace = dynamic(() => import('./CanvasWorkspace'), {
  ssr: false,
  loading: () => <div className="rainy-canvas" style={{ background: 'var(--canvas)' }} />,
})

export default function CanvasClient() {
  return (
    <div className="rainy-root">
      <CanvasWorkspace />
      <Sidebar />
      <Companion />
    </div>
  )
}
