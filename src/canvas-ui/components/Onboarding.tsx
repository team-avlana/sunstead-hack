'use client'

import { useEffect, useRef, useState } from 'react'
import { autofillProfile, type CreatorProfile, type Pet } from '@/lib/creatorRoom'

/**
 * A few-questions onboarding (Typeform-style, one screen at a time) that ends in
 * an LLM autofill: ask niche → vibe → name+pet, then expand into a full profile.
 * Decouples "questions asked" (3) from "fields filled" (~27). Never dead-ends.
 */

const NICHES = ['tech & lifestyle', 'cooking', 'fitness', 'gaming', 'beauty', 'travel', 'music', 'DIY & crafts']
const VIBES = ['cozy', 'warm', 'minimal', 'moody', 'playful', 'clean', 'bold', 'dreamy']
const PETS: { id: Pet; label: string; emoji: string }[] = [
  { id: 'cat', label: 'Cat', emoji: '🐱' },
  { id: 'dog', label: 'Dog', emoji: '🐶' },
  { id: 'none', label: 'None', emoji: '🪴' },
]
const MAX_VIBES = 3

export default function Onboarding({
  onComplete,
  onCancel,
}: {
  onComplete: (p: CreatorProfile) => void
  onCancel: () => void
}) {
  const [step, setStep] = useState(0)
  const [niche, setNiche] = useState('')
  const [vibe, setVibe] = useState<string[]>(['cozy', 'warm'])
  const [name, setName] = useState('')
  const [pet, setPet] = useState<Pet>('cat')
  const [busy, setBusy] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => () => abortRef.current?.abort(), [])

  const canNext = step === 0 ? niche.trim().length > 0 : step === 1 ? vibe.length > 0 : true

  const build = async () => {
    setBusy(true)
    const ctrl = new AbortController()
    abortRef.current = ctrl
    const profile = await autofillProfile({ niche: niche.trim(), vibe, name: name.trim() || 'Creator', pet }, ctrl.signal)
    if (!ctrl.signal.aborted) onComplete(profile)
  }

  const next = () => {
    if (!canNext) return
    if (step < 2) setStep((s) => s + 1)
    else void build()
  }
  const back = () => (step > 0 ? setStep((s) => s - 1) : onCancel())

  const toggleVibe = (v: string) =>
    setVibe((cur) => (cur.includes(v) ? cur.filter((x) => x !== v) : cur.length < MAX_VIBES ? [...cur, v] : cur))

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); next() }
    if (e.key === 'Escape') onCancel()
  }

  return (
    <div className="ob" onKeyDown={onKey}>
      <div className="ob-card" role="dialog" aria-modal="true" aria-label="Design your Creator Room">
        <button className="ob-close" onClick={onCancel} aria-label="Close">×</button>
        <div className="ob-dots" aria-hidden>
          {[0, 1, 2].map((i) => (
            <span key={i} className={i <= step ? 'on' : ''} />
          ))}
        </div>

        {busy ? (
          <div className="ob-building">
            <span className="room-spinner" />
            <span className="ob-q">Designing your studio…</span>
            <span className="ob-sub">Placing your shelves, gear, and {pet === 'none' ? 'props' : `your ${pet}`}.</span>
          </div>
        ) : (
          <div className="ob-step" key={step}>
            {step === 0 && (
              <>
                <h2 className="ob-q">What do you create?</h2>
                <p className="ob-sub">Your niche shapes the whole room.</p>
                {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
                <input className="ob-input" autoFocus value={niche} onChange={(e) => setNiche(e.target.value)} placeholder="e.g. cooking, fitness, tech reviews…" />
                <div className="ob-chips">
                  {NICHES.map((n) => (
                    <button key={n} className={`ob-chip${niche === n ? ' on' : ''}`} onClick={() => setNiche(n)}>{n}</button>
                  ))}
                </div>
              </>
            )}

            {step === 1 && (
              <>
                <h2 className="ob-q">What&apos;s the vibe?</h2>
                <p className="ob-sub">Pick up to {MAX_VIBES} — they set the palette &amp; lighting.</p>
                <div className="ob-chips">
                  {VIBES.map((v) => (
                    <button key={v} className={`ob-chip${vibe.includes(v) ? ' on' : ''}`} onClick={() => toggleVibe(v)}>{v}</button>
                  ))}
                </div>
              </>
            )}

            {step === 2 && (
              <>
                <h2 className="ob-q">Last thing — who&apos;s this for?</h2>
                <p className="ob-sub">A name and a companion for warmth.</p>
                {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
                <input className="ob-input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name (optional)" />
                <div className="ob-pets">
                  {PETS.map((p) => (
                    <button key={p.id} className={`ob-pet${pet === p.id ? ' on' : ''}`} onClick={() => setPet(p.id)}>
                      <span className="ob-pet-emoji">{p.emoji}</span>{p.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {!busy && (
          <div className="ob-nav">
            <button className="room-btn ghost" onClick={back}>{step === 0 ? 'Cancel' : 'Back'}</button>
            <button className="room-btn primary" onClick={next} disabled={!canNext}>
              {step < 2 ? 'Next' : 'Build my room'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
