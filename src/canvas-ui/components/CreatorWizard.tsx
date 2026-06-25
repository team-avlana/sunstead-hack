'use client'

import { useRef, useState } from 'react'
import {
  buildImagePrompt,
  buildPayload,
  COMPANION_PETS,
  CREATOR_TYPES,
  DEFAULT_AVATAR_DESCRIPTION,
  DEFAULT_PARAMS,
  MAX_VIBES,
  NICHES,
  ROOM_DESIGNS,
  VIBES,
  type CreatorRoomParams,
  type RoomGenerationPayload,
} from '@/lib/creatorRoomParams'

/**
 * The Creator Room wizard — collects the image-generation parameters
 * (docs/CREATOR_ROOM_IMAGE_PROMPT.md), assembles the `{ params, prompt, photo }`
 * payload, and hands it to `onComplete`. It does NOT call the image service yet
 * (the parent runs the stub `requestRoomGeneration`).
 */

const STEPS = 7 // 0 type+niche · 1 vibe · 2 room · 3 avatar · 4 shelf · 5 companion · 6 review

export default function CreatorWizard({
  onComplete,
  onCancel,
}: {
  onComplete: (payload: RoomGenerationPayload) => void
  onCancel: () => void
}) {
  const [step, setStep] = useState(0)
  const [p, setP] = useState<CreatorRoomParams>(DEFAULT_PARAMS)
  const [photo, setPhoto] = useState<{ name: string; dataUrl: string } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const set = (patch: Partial<CreatorRoomParams>) => setP((s) => ({ ...s, ...patch }))
  const toggleVibe = (v: string) =>
    setP((s) => ({
      ...s,
      vibe: s.vibe.includes(v) ? s.vibe.filter((x) => x !== v) : s.vibe.length < MAX_VIBES ? [...s.vibe, v] : s.vibe,
    }))

  const onPhoto = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const r = new FileReader()
    r.onload = () => {
      setPhoto({ name: file.name, dataUrl: String(r.result) })
      set({ avatarMode: 'photo', avatarPhotoName: file.name })
    }
    r.readAsDataURL(file)
  }

  const canNext =
    step === 0 ? p.niche.trim().length > 0 :
    step === 1 ? p.vibe.length > 0 :
    step === 3 ? (p.avatarMode === 'photo' ? !!photo : p.avatarDescription.trim().length > 0) :
    step === 5 ? (p.companionKind === 'pet' || (p.companionProp ?? '').trim().length > 0) :
    true

  const finish = () => onComplete(buildPayload(p, p.avatarMode === 'photo' && photo ? photo : undefined))
  const next = () => {
    if (!canNext) return
    if (step < STEPS - 1) setStep((s) => s + 1)
    else finish()
  }
  const back = () => (step > 0 ? setStep((s) => s - 1) : onCancel())

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') return onCancel()
    if (e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'TEXTAREA') {
      e.preventDefault()
      next()
    }
  }

  return (
    <div className="ob" onKeyDown={onKey}>
      <div className="ob-card wizard" role="dialog" aria-modal="true" aria-label="Design your Creator Room">
        <button className="ob-close" onClick={onCancel} aria-label="Close">×</button>
        <div className="ob-dots" aria-hidden>
          {Array.from({ length: STEPS }, (_, i) => (
            <span key={i} className={i <= step ? 'on' : ''} />
          ))}
        </div>

        <div className="ob-step" key={step}>
          {step === 0 && (
            <>
              <h2 className="ob-q">Let&apos;s set up your studio</h2>
              <p className="ob-sub">What kind of creator are you? This sets the gear in your room.</p>
              <div className="ob-opts">
                {CREATOR_TYPES.map((c) => (
                  <button key={c.id} className={`ob-opt${p.creatorType === c.id ? ' on' : ''}`} onClick={() => set({ creatorType: c.id })}>
                    <span className="ob-opt-emoji">{c.emoji}</span>
                    <span className="ob-opt-label">{c.label}</span>
                    <span className="ob-opt-blurb">{c.blurb}</span>
                  </button>
                ))}
              </div>
              <label className="ob-flabel" htmlFor="ob-niche">What do you create?</label>
              {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
              <input id="ob-niche" className="ob-input" autoFocus value={p.niche} onChange={(e) => set({ niche: e.target.value })} placeholder="e.g. cooking, tech reviews, travel films…" />
              <div className="ob-chips">
                {NICHES.map((n) => (
                  <button key={n} className={`ob-chip${p.niche === n ? ' on' : ''}`} onClick={() => set({ niche: n })}>{n}</button>
                ))}
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <h2 className="ob-q">What&apos;s the vibe?</h2>
              <p className="ob-sub">Pick up to {MAX_VIBES} — it shapes the feel (lighting stays cozy).</p>
              <div className="ob-chips">
                {VIBES.map((v) => (
                  <button key={v} className={`ob-chip${p.vibe.includes(v) ? ' on' : ''}`} onClick={() => toggleVibe(v)}>{v}</button>
                ))}
              </div>
              <input className="ob-input ob-mt" value={p.vibeExtra ?? ''} onChange={(e) => set({ vibeExtra: e.target.value })} placeholder="Add your own word (optional)…" />
            </>
          )}

          {step === 2 && (
            <>
              <h2 className="ob-q">Choose a room style</h2>
              <p className="ob-sub">Same layout every time — just a different look.</p>
              <div className="ob-chips">
                {ROOM_DESIGNS.map((r) => (
                  <button key={r} className={`ob-chip${p.roomDesign === r ? ' on' : ''}`} onClick={() => set({ roomDesign: r })}>{r}</button>
                ))}
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <h2 className="ob-q">Make your avatar</h2>
              <p className="ob-sub">Upload a photo to be turned into a clay character — or just describe one.</p>
              <div className="ob-seg">
                <button className={p.avatarMode === 'photo' ? 'on' : ''} onClick={() => set({ avatarMode: 'photo' })}>Upload photo</button>
                <button className={p.avatarMode === 'description' ? 'on' : ''} onClick={() => set({ avatarMode: 'description' })}>Describe</button>
              </div>
              {p.avatarMode === 'photo' ? (
                <div className="ob-upload">
                  <input ref={fileRef} type="file" accept="image/*" hidden onChange={onPhoto} />
                  {photo ? (
                    <div className="ob-upload-prev">
                      <img src={photo.dataUrl} alt="Your avatar source" />
                      <span className="ob-upload-name">{photo.name}</span>
                      <button className="ob-link" onClick={() => fileRef.current?.click()}>Change</button>
                    </div>
                  ) : (
                    <button className="ob-drop" onClick={() => fileRef.current?.click()}>
                      <span className="ob-drop-ico">📷</span>
                      <span className="ob-drop-main">Click to upload a photo</span>
                      <span className="ob-drop-hint">JPG or PNG · just your face is enough</span>
                    </button>
                  )}
                </div>
              ) : (
                <textarea
                  className="ob-textarea"
                  rows={3}
                  value={p.avatarDescription}
                  onChange={(e) => set({ avatarDescription: e.target.value })}
                  placeholder={DEFAULT_AVATAR_DESCRIPTION}
                />
              )}
            </>
          )}

          {step === 4 && (
            <>
              <h2 className="ob-q">What&apos;s on your shelf?</h2>
              <p className="ob-sub">Optional touches for your library wall — skip and we&apos;ll improvise.</p>
              <div className="ob-fields">
                <label><span>Interests</span><input className="ob-input" value={p.interests} onChange={(e) => set({ interests: e.target.value })} placeholder="photography, coffee, travel…" /></label>
                <label><span>Books</span><input className="ob-input" value={p.books} onChange={(e) => set({ books: e.target.value })} placeholder="Deep Work, Atomic Habits…" /></label>
                <label><span>Shows &amp; films</span><input className="ob-input" value={p.showsFilms} onChange={(e) => set({ showsFilms: e.target.value })} placeholder="Chef, Blade Runner…" /></label>
                <label><span>Role models</span><input className="ob-input" value={p.roleModels} onChange={(e) => set({ roleModels: e.target.value })} placeholder="Casey, Deakins…" /></label>
              </div>
            </>
          )}

          {step === 5 && (
            <>
              <h2 className="ob-q">Pick a companion</h2>
              <p className="ob-sub">A pet — or a personal object that&apos;s just you.</p>
              <div className="ob-pets">
                {COMPANION_PETS.map((c) => (
                  <button
                    key={c.id}
                    className={`ob-pet${p.companionKind === 'pet' && p.companionPet === c.id ? ' on' : ''}`}
                    onClick={() => set({ companionKind: 'pet', companionPet: c.id, companionProp: '' })}
                  >
                    <span className="ob-pet-emoji">{c.emoji}</span>{c.label}
                  </button>
                ))}
              </div>
              <div className="ob-or">or a personal prop</div>
              <input
                className="ob-input"
                value={p.companionProp ?? ''}
                onChange={(e) => set({ companionProp: e.target.value, companionKind: e.target.value.trim() ? 'prop' : 'pet' })}
                placeholder="e.g. a vintage guitar, a skateboard, a vinyl player…"
              />
            </>
          )}

          {step === 6 && (
            <>
              <h2 className="ob-q">Ready to generate ✨</h2>
              <p className="ob-sub">Here&apos;s your room brief. Generation hooks up to the service next.</p>
              <div className="ob-review">
                <Row label="Creator" value={CREATOR_TYPES.find((c) => c.id === p.creatorType)?.label} />
                <Row label="Creates" value={p.niche} />
                <Row label="Vibe" value={[...p.vibe, p.vibeExtra ?? ''].filter(Boolean).join(', ')} />
                <Row label="Room style" value={p.roomDesign} />
                <Row label="Avatar" value={p.avatarMode === 'photo' ? (photo?.name ?? 'uploaded photo') : p.avatarDescription} />
                <Row label="Companion" value={p.companionKind === 'pet' ? COMPANION_PETS.find((c) => c.id === p.companionPet)?.label : p.companionProp} />
              </div>
              <details className="ob-prompt-wrap">
                <summary>View the full generated prompt</summary>
                <pre className="ob-prompt">{buildImagePrompt(p)}</pre>
              </details>
            </>
          )}
        </div>

        <div className="ob-nav">
          <button className="room-btn ghost" onClick={back}>{step === 0 ? 'Cancel' : 'Back'}</button>
          <button className="room-btn primary" onClick={next} disabled={!canNext}>
            {step === STEPS - 1 ? 'Generate my room' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value?: string }) {
  return (
    <div className="ob-review-row">
      <span className="ob-review-k">{label}</span>
      <span className="ob-review-v">{value && value.trim() ? value : '—'}</span>
    </div>
  )
}
