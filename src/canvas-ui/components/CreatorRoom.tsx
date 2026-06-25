'use client'

import { useEffect, useState } from 'react'
import CreatorWizard from './CreatorWizard'
import { requestRoomGeneration, type RoomGenerationPayload } from '@/lib/creatorRoomParams'
import { clearGeneratedImage, DEFAULT_ROOM_IMAGE } from '@/lib/creatorRoom'

type Status = { kind: 'idle' | 'hint'; msg?: string }

/**
 * The Creator Room hero — a clean 2D clay-render image. We always show the
 * bundled default room (image generation via the Python service is still a stub,
 * so it never produces a real custom image yet). A single clean "Design my room"
 * pill floats over the art and opens the wizard to collect/revise the room brief.
 * (The earlier 3D diorama UI was retired — see git.)
 */
export default function CreatorRoom() {
  const [wizard, setWizard] = useState(false)
  const [briefSaved, setBriefSaved] = useState(false)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  useEffect(() => {
    // Generation produces no real image yet, so anything in the legacy
    // `rainy:room:image` slot is stale — purge it so an old cached image can't
    // flash over the default room. (Previously it was loaded and painted on top.)
    clearGeneratedImage()
    setBriefSaved(!!window.localStorage.getItem('rainy:room:profile'))
  }, [])

  // Wizard finished → (stub) trigger generation + hint. The real 2D render comes
  // from the Python service later; today this just saves the brief.
  const onWizardComplete = (payload: RoomGenerationPayload) => {
    setWizard(false)
    setBriefSaved(true)
    void requestRoomGeneration(payload)
    setStatus({ kind: 'hint', msg: 'Saved your room brief ✨ — Rainey will paint it from the service soon.' })
  }

  return (
    <section className="room">
      <div className="room-stage">
        <img className="room-img" src={DEFAULT_ROOM_IMAGE} alt="Your Creator Room" />

        {/* One clean, always-visible pill keeps the wizard a tap away. */}
        <button className="room-redesign" onClick={() => setWizard(true)}>
          <SparkIcon />
          {briefSaved ? 'Redesign room' : 'Design my room'}
        </button>

        {status.msg && <div className={`room-status ${status.kind}`} role="status">{status.msg}</div>}
      </div>

      {wizard && <CreatorWizard onComplete={onWizardComplete} onCancel={() => setWizard(false)} />}
    </section>
  )
}

function SparkIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2.5l1.7 5.1a4 4 0 0 0 2.7 2.7l5.1 1.7-5.1 1.7a4 4 0 0 0-2.7 2.7L12 21.5l-1.7-5.1a4 4 0 0 0-2.7-2.7L2.5 12l5.1-1.7a4 4 0 0 0 2.7-2.7L12 2.5z" />
    </svg>
  )
}
