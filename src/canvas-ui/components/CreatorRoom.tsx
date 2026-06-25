'use client'

import { useEffect, useRef, useState } from 'react'
import { postNative } from '@/lib/bridge'
import CreatorWizard from './CreatorWizard'
import { requestRoomGeneration, type RoomGenerationPayload } from '@/lib/creatorRoomParams'
import {
  apiBase,
  buildRoomDoc,
  DEFAULT_PROFILE,
  generateRoomDoc,
  generateRoomImage,
  GenerationUnavailable,
  loadGeneratedImage,
  loadGeneratedRoom,
  loadMode,
  loadProfile,
  SAMPLE_IMAGE,
  saveGeneratedImage,
  saveGeneratedRoom,
  saveMode,
  saveProfile,
  type CreatorProfile,
  type Lighting,
  type Pet,
  type RoomMode,
  type Shooter,
} from '@/lib/creatorRoom'

// ---- raw-string form <-> profile -----------------------------------------
interface Form {
  name: string; niche: string; vibe: string
  shooter: Shooter; editingApp: string; gear: string
  interests: string; reads: string; shows: string; roleModels: string
  lighting: Lighting; materials: string; palette: string
  pet: Pet; props: string
  tech: string; lifestyle: string
}

const splitC = (s: string) => s.split(',').map((t) => t.trim()).filter(Boolean)
const joinC = (a: string[]) => a.join(', ')
const parseLinks = (s: string) =>
  splitC(s).map((item) => {
    const [label, link] = item.split('|').map((x) => x.trim())
    return { label, link: link || undefined }
  })
const joinLinks = (a: { label: string; link?: string }[]) =>
  a.map((l) => (l.link ? `${l.label} | ${l.link}` : l.label)).join(', ')

function profileToForm(p: CreatorProfile): Form {
  return {
    name: p.creator.name, niche: p.creator.niche, vibe: joinC(p.creator.vibe),
    shooter: p.content.shooter, editingApp: p.content.editingApp, gear: joinC(p.content.gear),
    interests: joinC(p.library.interests), reads: joinC(p.library.reads), shows: joinC(p.library.shows), roleModels: joinC(p.library.roleModels),
    lighting: p.style.lighting, materials: p.style.materials, palette: joinC(p.style.palette),
    pet: p.companions.pet, props: joinC(p.companions.props),
    tech: joinLinks(p.referral.tech), lifestyle: joinLinks(p.referral.lifestyle),
  }
}
function formToProfile(f: Form): CreatorProfile {
  return {
    creator: { name: f.name.trim() || 'Creator', niche: f.niche.trim(), vibe: splitC(f.vibe) },
    library: { interests: splitC(f.interests), reads: splitC(f.reads), shows: splitC(f.shows), roleModels: splitC(f.roleModels) },
    content: { shooter: f.shooter, gear: splitC(f.gear), editingApp: f.editingApp.trim() },
    referral: { tech: parseLinks(f.tech), lifestyle: parseLinks(f.lifestyle) },
    style: { palette: splitC(f.palette), lighting: f.lighting, materials: f.materials.trim() || 'wood+linen' },
    companions: { pet: f.pet, props: splitC(f.props) },
  }
}

type Status = { kind: 'idle' | 'generating' | 'error' | 'hint'; msg?: string }

/** The hero Creator Room: an image (default) or 3D diorama, driven by the intake. */
export default function CreatorRoom() {
  // SSR renders deterministic defaults; real state is loaded from localStorage
  // after mount (see the hydrate effect) so server and client markup agree.
  const [form, setForm] = useState<Form>(() => profileToForm(DEFAULT_PROFILE))
  const [mode, setMode] = useState<RoomMode>('image')
  const [wizard, setWizard] = useState(false)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [hydrated, setHydrated] = useState(false)

  // image mode
  const [image, setImage] = useState<string | null>(null)

  // 3D mode (built lazily when first shown)
  const [srcDoc, setSrcDoc] = useState<string>('')
  const [room3dMode, setRoom3dMode] = useState<'procedural' | 'generated'>('procedural')
  const [loaded3d, setLoaded3d] = useState(false)

  const abortRef = useRef<AbortController | null>(null)
  const debounceRef = useRef<number | undefined>(undefined)
  // The form-change effect treats form edits as user intent (re-save + rebuild the
  // preview). Hydration also sets the form once — skip that first programmatic change
  // so it doesn't reset loaded3d and strand the loading overlay.
  const skipFormEffect = useRef(true)

  // Hydrate from localStorage once, after mount. Reading storage during render
  // would make the client markup diverge from the server's and break hydration.
  useEffect(() => {
    const profile = loadProfile()
    const m = loadMode()
    const savedRoom = loadGeneratedRoom()
    setForm(profileToForm(profile))
    setMode(m)
    setImage(loadGeneratedImage())
    setRoom3dMode(savedRoom ? 'generated' : 'procedural')
    if (m === 'room3d') {
      setLoaded3d(false)
      setSrcDoc(savedRoom ?? buildRoomDoc(profile))
    }
    // First visit (nothing saved yet) → open the few-questions onboarding.
    if (!window.localStorage.getItem('rainy:room:profile')) setWizard(true)
    setHydrated(true)
  }, [])

  // Build the 3D doc lazily the first time 3D is shown; persist the mode.
  useEffect(() => {
    if (!hydrated) return
    saveMode(mode)
    if (mode === 'room3d' && !srcDoc) {
      setLoaded3d(false)
      setSrcDoc(loadGeneratedRoom() ?? buildRoomDoc(formToProfile(form)))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  // Save the profile on edit; live-rebuild the procedural 3D preview when shown.
  useEffect(() => {
    if (!hydrated) return
    if (skipFormEffect.current) { skipFormEffect.current = false; return }
    window.clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => {
      const p = formToProfile(form)
      saveProfile(p)
      if (mode === 'room3d') {
        setRoom3dMode('procedural')
        setLoaded3d(false)
        setSrcDoc(buildRoomDoc(p))
      }
    }, 650)
    return () => window.clearTimeout(debounceRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form])

  // 3D hotspot links + ready signal.
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data
      if (!d || d.source !== 'rainy-room') return
      if (d.type === 'ready') setLoaded3d(true)
      if (d.type === 'hotspot' && d.link) {
        postNative({ type: 'openExternalURL', url: d.link })
        window.open(d.link, '_blank', 'noopener,noreferrer')
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  useEffect(() => () => abortRef.current?.abort(), [])

  const runGenerate = async (p: CreatorProfile) => {
    saveProfile(p)

    if (!apiBase()) {
      setStatus({
        kind: 'hint',
        msg: mode === 'image'
          ? 'Connect the Comms Service (NEXT_PUBLIC_COMMS_API_URL + OPENAI_API_KEY) to paint your room. Showing the style sample.'
          : 'Connect the Comms Service to generate the 3D room. Showing the live preview.',
      })
      if (mode === 'room3d') { setRoom3dMode('procedural'); setLoaded3d(false); setSrcDoc(buildRoomDoc(p)) }
      return
    }

    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setStatus({ kind: 'generating' })

    try {
      if (mode === 'image') {
        const dataUrl = await generateRoomImage(p, ctrl.signal)
        saveGeneratedImage(dataUrl)
        setImage(dataUrl)
      } else {
        const html = await generateRoomDoc(p, ctrl.signal)
        saveGeneratedRoom(html)
        setRoom3dMode('generated')
        setLoaded3d(false)
        setSrcDoc(html)
      }
      setStatus({ kind: 'idle' })
    } catch (err) {
      if (ctrl.signal.aborted) return
      const unavailable = err instanceof GenerationUnavailable
      setStatus({
        kind: unavailable ? 'hint' : 'error',
        msg: mode === 'image'
          ? `${unavailable ? 'Image service not configured' : `Couldn't paint the room (${(err as Error).message})`} — showing the style sample.`
          : `${unavailable ? 'Generation not configured' : `Couldn't generate (${(err as Error).message})`} — showing the live preview.`,
      })
      if (mode === 'room3d') { setRoom3dMode('procedural'); setLoaded3d(false); setSrcDoc(buildRoomDoc(p)) }
    }
  }

  const onGenerate = () => void runGenerate(formToProfile(form))

  // Wizard finished → assemble the brief and (stub) trigger generation. The real
  // POST to the image service is the cofounder's endpoint; today this only
  // persists the payload and shows a friendly "ready" hint.
  const onWizardComplete = (payload: RoomGenerationPayload) => {
    setWizard(false)
    void requestRoomGeneration(payload)
    setStatus({ kind: 'hint', msg: 'Saved your room brief ✨ — image generation will hook up to the service soon.' })
  }

  const generating = status.kind === 'generating'
  const showSample = mode === 'image' && !image
  const showLoading = generating || (mode === 'room3d' && !!srcDoc && !loaded3d)

  return (
    <section className="room">
      <div className="room-stage">
        {mode === 'image' ? (
          <>
            <img className={`room-img${showSample ? ' sample' : ''}`} src={image ?? SAMPLE_IMAGE} alt="Your Creator Room" />
            {showSample && !generating && (
              <div className="room-cta">
                <span className="room-cta-title">Paint your Creator Room</span>
                <span className="room-cta-sub">Answer three quick questions and Rainy renders your cozy clay room — character and all.</span>
                <button className="room-btn primary" onClick={() => setWizard(true)}>✨ Design my room</button>
              </div>
            )}
          </>
        ) : (
          <iframe
            key={room3dMode}
            className="room-frame"
            title="Creator Room (3D)"
            sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
            srcDoc={srcDoc}
          />
        )}

        {showLoading && (
          <div className="room-loading" aria-hidden>
            <span className="room-spinner" />
            <span>{generating ? 'Rainy is building your room…' : 'Loading room…'}</span>
          </div>
        )}

        <div className="room-overlay">
          <div className="room-meta">
            <span className="room-kicker">Your Creator Room</span>
            <span className="room-sub">
              {mode === 'image' ? (image ? 'Generated by Rainy' : 'Style sample') : room3dMode === 'generated' ? '3D · generated' : '3D · live preview'}
            </span>
          </div>
          <div className="room-top-actions">
            <div className="room-seg" role="tablist" aria-label="Render mode">
              <button className={mode === 'image' ? 'on' : ''} onClick={() => setMode('image')}>Image</button>
              <button className={mode === 'room3d' ? 'on' : ''} onClick={() => setMode('room3d')}>3D</button>
            </div>
            <button className="room-btn ghost" onClick={() => setWizard(true)}>✨ Redesign</button>
            <button className="room-btn primary" onClick={onGenerate} disabled={generating}>
              {generating ? 'Generating…' : 'Generate with Rainy'}
            </button>
          </div>
        </div>

        {status.msg && <div className={`room-status ${status.kind}`} role="status">{status.msg}</div>}
      </div>

      <button className="room-edit-toggle" onClick={() => setWizard(true)}>
        Edit details
      </button>

      {wizard && <CreatorWizard onComplete={onWizardComplete} onCancel={() => setWizard(false)} />}
    </section>
  )
}
