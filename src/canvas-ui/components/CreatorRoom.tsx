'use client'

import { useEffect, useState } from 'react'
import CreatorWizard from './CreatorWizard'
import { requestRoomGeneration, type RoomGenerationPayload } from '@/lib/creatorRoomParams'
import { clearGeneratedImage, DEFAULT_ROOM_IMAGE } from '@/lib/creatorRoom'
import { fetchSelfCreator, hasBackend, roomImageUrl } from '@/lib/api'

type Status = { kind: 'idle' | 'hint'; msg?: string }

/**
 * The Creator Room hero — a clean 2D clay-render image. Shows the backend-
 * generated room when one exists for the 'self' creator, otherwise the bundled
 * default. A single clean "Design my room" pill floats over the art and opens
 * the wizard; finishing it POSTs the brief to the python-service, which renders
 * the room from the prompt + the creator's real talking-head frames.
 */
export default function CreatorRoom() {
  const [wizard, setWizard] = useState(false)
  const [briefSaved, setBriefSaved] = useState(false)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [roomSrc, setRoomSrc] = useState<string>(DEFAULT_ROOM_IMAGE)
  const [generating, setGenerating] = useState(false)

  useEffect(() => {
    // The legacy `rainy:room:image` slot is unused now — purge any stale value.
    clearGeneratedImage()
    setBriefSaved(!!window.localStorage.getItem('rainy:room:profile'))
    // If the backend already rendered a room for this user, show it.
    let alive = true
    if (hasBackend()) {
      void fetchSelfCreator().then((self) => {
        if (!alive || !self?.has_room_image) return
        const url = roomImageUrl(self.creator_id, self.style_profile_at ?? 'saved')
        if (url) setRoomSrc(url)
      })
    }
    return () => {
      alive = false
    }
  }, [])

  // Wizard finished → POST the brief to the service and swap in the rendered room.
  const onWizardComplete = async (payload: RoomGenerationPayload) => {
    setWizard(false)
    setBriefSaved(true)
    setGenerating(true)
    setStatus({ kind: 'hint', msg: 'Designing your room… this takes ~20s ✨' })
    const result = await requestRoomGeneration(payload)
    setGenerating(false)
    if (result.ok) {
      setRoomSrc(result.imageUrl)
      setStatus({ kind: 'hint', msg: 'Your Creator Room is ready ✨' })
    } else if (result.reason === 'no-backend') {
      setStatus({ kind: 'hint', msg: 'Saved your room brief — connect the service to generate it.' })
    } else {
      setStatus({ kind: 'hint', msg: 'Couldn’t generate the room just now — your brief is saved, try again.' })
    }
  }

  return (
    <section className="room">
      <div className={`room-stage${generating ? ' generating' : ''}`}>
        <img className="room-img" src={roomSrc} alt="Your Creator Room" />
        {generating && (
          <div className="room-generating" role="status" aria-live="polite">
            <span className="room-generating-spin" aria-hidden />
            <span>Designing your room…</span>
          </div>
        )}

        {/* Two glass collapsibles float over the art — the library (docs) top-left
            and the content-setup (presets + style) bottom-right, echoing the room. */}
        <OverlayCard data={LIBRARY_CARD} corner="tl" />
        <OverlayCard data={CONTENT_SETUP_CARD} corner="br" />

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

/* ============================================================
   Overlay collapsibles — two glass cards over the room art.
   Two levels of disclosure: the whole card folds, and each
   section folds independently to reveal its labelled items.
   ============================================================ */

type OverlayItem = { label: string; body: string }
type OverlaySection = { label: string; items: OverlayItem[] }
type OverlayCardData = { title: string; sections: OverlaySection[] }

function OverlayCard({ data, corner }: { data: OverlayCardData; corner: 'tl' | 'br' }) {
  // Card opens to show its section rows; sections start folded for a calm, compact look.
  const [open, setOpen] = useState(true)
  return (
    <div className={`room-overlay ${corner} ${open ? 'open' : 'closed'}`}>
      <button
        type="button"
        className="room-overlay-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="room-overlay-title">{data.title}</span>
        <Chevron open={open} />
      </button>

      {open && (
        <div className="room-overlay-body">
          {data.sections.map((s) => (
            <OverlaySectionRow key={s.label} section={s} />
          ))}
        </div>
      )}
    </div>
  )
}

function OverlaySectionRow({ section }: { section: OverlaySection }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`room-overlay-section ${open ? 'open' : 'closed'}`}>
      <button
        type="button"
        className="room-overlay-sec-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Chevron open={open} small />
        <span className="room-overlay-sec-label">{section.label}</span>
      </button>

      {open && (
        <ul className="room-overlay-items">
          {section.items.map((it) => (
            <li className="room-overlay-item" key={it.label}>
              <span className="room-overlay-item-label">{it.label}</span>
              <span className="room-overlay-item-body">{it.body}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Chevron({ open, small }: { open: boolean; small?: boolean }) {
  const s = small ? 12 : 14
  return (
    <svg
      className={`room-overlay-chev ${open ? 'open' : ''}`}
      width={s}
      height={s}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  )
}

// ---- Card content (hand-authored; mirrors the creator's library + setup) ----

const LIBRARY_CARD: OverlayCardData = {
  title: 'My Library',
  sections: [
    {
      label: 'Scripts, plans, etc.',
      items: [
        {
          label: 'First 10 videos (concept + format)',
          body: '“You don’t have a content problem. You have a story problem.”, “Why showing everything is killing your videos”, “90% of people aren’t using AI. The other 10% aren’t either, really.”, “The friction that matters”, “If I could give you your time back, what would you do with it?”',
        },
        {
          label: 'Content pipeline (drafts & ideas)',
          body: 'Automated Editing vs. Editing Intelligence, Power Laws of Content, Power Laws pt. ii: Fail more, When to not use AI, youtube longform – 22.05, Vlogs → Paying Customers, A POC is Not a POC, 30 Min Call. Sold in the Last 5., A-Roll Guide (Lead Magnet), why every tech brand needs a longform creator on payroll',
        },
        {
          label: 'Topic pillars',
          body: 'AI Hype vs Reality · Creativity & Storytelling · Building · Mindset & Habits · Lifestyle',
        },
      ],
    },
    {
      label: 'Unstructured notes',
      items: [
        {
          label: 'Thought-Dump',
          body: 'Tuesday morning reflections on product focus, storytelling, and over-engineering content',
        },
        {
          label: 'Sparring transcripts with Rickie',
          body: 'on story-building & characters',
        },
        {
          label: 'Inspiration captures',
          body: 'Inspiration (21.05.2026), Inspiration (02.06.2026), Inspiration (04.05.2026), “ooze”',
        },
      ],
    },
    {
      label: 'Inspiration',
      items: [
        { label: 'recent reads', body: '(none captured on this page yet)' },
        { label: 'books', body: '(none captured on this page yet)' },
        {
          label: 'movies',
          body: '“I Deliver Parcels in Beijing” (the 10% rule — a good story is only ever about 10% of the whole picture)',
        },
        {
          label: 'role models',
          body: 'Joshua Bonzo (cinematic, music, story > hype), Daniel Dalen (confident, motivational, authority through lifestyle), Sam Nowden / Kirxdiaz / Faizan (articulate, poetic, nostalgic); plus Rickie (story-building sparring) and Freddie (format that hit 10M views)',
        },
      ],
    },
  ],
}

const CONTENT_SETUP_CARD: OverlayCardData = {
  title: 'Content Setup',
  sections: [
    {
      label: 'My Presets',
      items: [
        {
          label: 'Multipliers',
          body: 'same video / different hook, change outfit or location, talking head + B-roll, before/after, screen recording tutorials, POV reactions',
        },
        {
          label: 'Hook formulas',
          body: '“I went from X to Y in Z days”, “This hack got me X results”, “X mistakes ICP makes with Y”, “If you’re struggling with X, try Y”, “Stop doing X if you want Y results”',
        },
        {
          label: 'Camera angles',
          body: 'eye level, side profile, top down, over shoulder, walking & following, screen recording overlay, POV perspective',
        },
        {
          label: 'B-roll bank',
          body: 'phone on tripod, coffee, work setup, walking w/ phone, notebook writing, hand gestures, screen recording demos, outdoor shorts',
        },
      ],
    },
    {
      label: 'My Style',
      items: [
        {
          label: 'captions / voice',
          body: 'warm, kind, precise, intentional; honest curiosity over cynicism; honest without preachy or dunking. No em-dashes, no “not this, but that” structures',
        },
        {
          label: 'colors',
          body: 'warm, natural light; mid-century palette; a visual counterbalance to AI chaos (no studio-lit, over-polished look)',
        },
        {
          label: 'look & feel',
          body: 'cinematic but not overproduced — north star is “just hit record”; restraint / the 10% rule; B-roll heavy; 2–3 min short-form reflections + longer cozy YouTube explorations',
        },
        {
          label: 'moodboard',
          body: 'mid-century, metropolitan, coffee, cats, cozy spaces; specialty cafés, design bookstores, independent cinemas, museum cafés; running routes, hackathons, founder offsites; cities with character (Berlin, Lisbon, Tokyo)',
        },
      ],
    },
  ],
}
