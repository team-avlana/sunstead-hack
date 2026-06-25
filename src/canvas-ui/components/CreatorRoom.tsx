'use client'

import { useEffect, useState } from 'react'
import CreatorWizard from './CreatorWizard'
import { requestRoomGeneration, type RoomGenerationPayload } from '@/lib/creatorRoomParams'
import { loadGeneratedImage, SAMPLE_IMAGE } from '@/lib/creatorRoom'

type Status = { kind: 'idle' | 'hint'; msg?: string }

/**
 * The Creator Room hero — a clean 2D image. The painted room is produced by the
 * Python service; until one exists we show the bundled reference sample, blurred.
 * A subtle "Redesign" affordance opens the wizard to (re)collect the room brief.
 * (The earlier in-browser 3D diorama + live-generate UI was retired — see git.)
 */
export default function CreatorRoom() {
  // SSR renders the deterministic sample; the real (cached) image loads on mount
  // so server and client markup agree.
  const [image, setImage] = useState<string | null>(null)
  const [wizard, setWizard] = useState(false)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  useEffect(() => {
    setImage(loadGeneratedImage())
    // First visit (no brief saved yet) → invite them to design their room.
    if (!window.localStorage.getItem('rainy:room:profile')) setWizard(true)
  }, [])

  // Wizard finished → persist the brief and (stub) trigger generation. The real
  // 2D render comes from the Python service; today this saves the payload + hints.
  const onWizardComplete = (payload: RoomGenerationPayload) => {
    setWizard(false)
    void requestRoomGeneration(payload)
    setStatus({ kind: 'hint', msg: 'Saved your room brief ✨ — Rainy will paint it from the service soon.' })
  }

  const showSample = !image

  return (
    <section className="room">
      <div className="room-stage">
        <img className={`room-img${showSample ? ' sample' : ''}`} src={image ?? SAMPLE_IMAGE} alt="Your Creator Room" />

        {showSample && (
          <div className="room-cta">
            <span className="room-cta-title">Your Creator Room</span>
            <span className="room-cta-sub">Answer a few quick questions and Rainy paints your cozy clay room — character and all.</span>
            <button className="room-btn primary" onClick={() => setWizard(true)}>✨ Design my room</button>
          </div>
        )}

        {/* Bare image once painted; a subtle hover button keeps the wizard reachable. */}
        {!showSample && (
          <button className="room-redesign" onClick={() => setWizard(true)}>✨ Redesign</button>
        )}

        {status.msg && <div className={`room-status ${status.kind}`} role="status">{status.msg}</div>}
      </div>

      {wizard && <CreatorWizard onComplete={onWizardComplete} onCancel={() => setWizard(false)} />}
    </section>
  )
}
