'use client'

import { useCallback, useEffect, useState } from 'react'
import styles from './agency.module.css'
import Roster from './Roster'
import CreatorDetail from './CreatorDetail'
import DeliveryDetail from './DeliveryDetail'
import NewDeliveryModal from './NewDeliveryModal'

type Route =
  | { name: 'roster' }
  | { name: 'creator'; id: string }
  | { name: 'review'; id: string }

function parseHash(): Route {
  const h = typeof window !== 'undefined' ? window.location.hash : ''
  let m: RegExpMatchArray | null
  if ((m = h.match(/^#\/c\/(.+)$/))) return { name: 'creator', id: decodeURIComponent(m[1]) }
  if ((m = h.match(/^#\/r\/(.+)$/))) return { name: 'review', id: decodeURIComponent(m[1]) }
  return { name: 'roster' }
}

export interface Nav {
  roster: () => void
  creator: (id: string) => void
  review: (id: string) => void
}

export default function AgencyApp() {
  const [route, setRoute] = useState<Route>({ name: 'roster' })
  const [modal, setModal] = useState<{ open: boolean; creatorId?: string }>({ open: false })

  // Hash ↔ state, so deep links / refresh / back-forward all work in the static export.
  useEffect(() => {
    const sync = () => setRoute(parseHash())
    sync()
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [])

  const go = useCallback((hash: string) => {
    if (window.location.hash !== hash) window.location.hash = hash
    else setRoute(parseHash())
  }, [])

  const nav: Nav = {
    roster: () => go('#/'),
    creator: (id) => go(`#/c/${encodeURIComponent(id)}`),
    review: (id) => go(`#/r/${encodeURIComponent(id)}`),
  }

  const openNew = (creatorId?: string) => setModal({ open: true, creatorId })

  return (
    <div className={styles.app}>
      <header className={styles.topbar}>
        <div className={styles.brand} onClick={nav.roster}>
          <span className={styles.brandMark}>R</span>
          Rainey
          <span className={styles.brandTag}>Agency</span>
        </div>
        <div className={styles.spacer} />
        <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => openNew()}>
          + New review
        </button>
      </header>

      {route.name === 'roster' && <Roster key="roster" nav={nav} onNew={openNew} />}
      {route.name === 'creator' && (
        <CreatorDetail key={`c:${route.id}`} creatorId={route.id} nav={nav} onNew={openNew} />
      )}
      {route.name === 'review' && <DeliveryDetail key={`r:${route.id}`} reviewId={route.id} nav={nav} />}

      {modal.open && (
        <NewDeliveryModal
          defaultCreatorId={modal.creatorId}
          onClose={() => setModal({ open: false })}
          onCreated={(reviewId) => {
            setModal({ open: false })
            nav.review(reviewId)
          }}
        />
      )}
    </div>
  )
}
