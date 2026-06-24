'use client'

import { useRainyStore, type CommsStatus } from '@/lib/store'

const NAV = ['Canvas', 'Creators', 'Videos', 'Analyses']

const STATUS_LABEL: Record<CommsStatus, string> = {
  idle: 'Idle',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  mock: 'Mock agent',
}

export default function Sidebar() {
  const status = useRainyStore((s) => s.commsStatus)
  const selectedCount = useRainyStore((s) => s.selectedIds.length)

  return (
    <aside className="rainy-sidebar">
      <div className="rainy-brand">
        <span className="dot" /> Rainy
      </div>

      <nav className="rainy-nav">
        {NAV.map((item, i) => (
          <button key={item} className={i === 0 ? 'active' : ''} type="button">
            {item}
          </button>
        ))}
      </nav>

      <div>
        <div className="rainy-section-title">Projects</div>
        <div className="rainy-projects">
          <button className="rainy-project active" type="button">
            Untitled board
          </button>
        </div>
      </div>

      <div className="rainy-spacer" />

      <div className="rainy-status">
        <span className={`led ${status}`} /> {STATUS_LABEL[status]} · {selectedCount} selected
      </div>
    </aside>
  )
}
