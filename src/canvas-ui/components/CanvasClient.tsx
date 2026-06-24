'use client'

import dynamic from 'next/dynamic'
import Sidebar from './Sidebar'
import Header from './Header'
import PromptBar from './PromptBar'
import ZoomControls from './ZoomControls'

// ssr:false is legal here because this file is a Client Component (App Router rule).
const CanvasWorkspace = dynamic(() => import('./CanvasWorkspace'), {
  ssr: false,
  loading: () => <div className="rainy-canvas" style={{ background: 'var(--canvas)' }} />,
})

export default function CanvasClient() {
  return (
    <div className="page">
      <div className="canvas-card">
        <CanvasWorkspace />
        <Sidebar />
        <Header />
        <ZoomControls />
        <PromptBar />
      </div>
    </div>
  )
}
