'use client'

import { useEffect, useRef, useState } from 'react'
import { postNative } from '@/lib/bridge'
import Onboarding from './Onboarding'
import {
  apiBase,
  buildRoomDoc,
  clearGeneratedImage,
  clearGeneratedRoom,
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
  const [form, setForm] = useState<Form>(() => profileToForm(loadProfile()))
  const [mode, setMode] = useState<RoomMode>(() => loadMode())
  const [open, setOpen] = useState(false)
  const [wizard, setWizard] = useState(false)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  // First visit (nothing saved yet) → open the few-questions onboarding.
  useEffect(() => {
    if (typeof window !== 'undefined' && !window.localStorage.getItem('rainy:room:profile')) setWizard(true)
  }, [])

  // image mode
  const [image, setImage] = useState<string | null>(() => loadGeneratedImage())

  // 3D mode (built lazily when first shown)
  const [srcDoc, setSrcDoc] = useState<string>('')
  const [room3dMode, setRoom3dMode] = useState<'procedural' | 'generated'>(() => (loadGeneratedRoom() ? 'generated' : 'procedural'))
  const [loaded3d, setLoaded3d] = useState(false)

  const abortRef = useRef<AbortController | null>(null)
  const debounceRef = useRef<number | undefined>(undefined)
  const firstRun = useRef(true)

  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }))

  // Build the 3D doc lazily the first time 3D is shown; persist the mode.
  useEffect(() => {
    saveMode(mode)
    if (mode === 'room3d' && !srcDoc) {
      setLoaded3d(false)
      setSrcDoc(loadGeneratedRoom() ?? buildRoomDoc(formToProfile(form)))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  // Save the profile on edit; live-rebuild the procedural 3D preview when shown.
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return }
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

  // Onboarding finished → adopt the autofilled profile and generate immediately.
  const onWizardComplete = (profile: CreatorProfile) => {
    setForm(profileToForm(profile))
    saveProfile(profile)
    setWizard(false)
    setOpen(false)
    void runGenerate(profile)
  }

  const onReset = () => {
    abortRef.current?.abort()
    clearGeneratedImage()
    clearGeneratedRoom()
    setImage(null)
    const f = profileToForm(DEFAULT_PROFILE)
    setForm(f)
    saveProfile(DEFAULT_PROFILE)
    setRoom3dMode('procedural')
    setLoaded3d(false)
    setSrcDoc(buildRoomDoc(DEFAULT_PROFILE))
    setStatus({ kind: 'idle' })
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

      <button className="room-edit-toggle" onClick={() => setOpen((o) => !o)}>
        {open ? 'Hide details' : 'Edit details'}
      </button>

      {wizard && <Onboarding onComplete={onWizardComplete} onCancel={() => setWizard(false)} />}

      {open && (
        <div className="room-form">
          <Group title="Creator">
            <Field label="Name"><input value={form.name} onChange={set('name')} placeholder="Your name" /></Field>
            <Field label="Niche"><input value={form.niche} onChange={set('niche')} placeholder="tech reviews, travel…" /></Field>
            <Field label="Vibe (3 words)" wide><input value={form.vibe} onChange={set('vibe')} placeholder="cozy, warm, minimal" /></Field>
          </Group>

          <Group title="Library — back wall">
            <Field label="Interests" wide><input value={form.interests} onChange={set('interests')} placeholder="photography, coffee, design" /></Field>
            <Field label="Recent reads" wide><input value={form.reads} onChange={set('reads')} placeholder="Deep Work, Atomic Habits" /></Field>
            <Field label="Shows / films"><input value={form.shows} onChange={set('shows')} placeholder="Chef, Lost in Translation" /></Field>
            <Field label="Role models"><input value={form.roleModels} onChange={set('roleModels')} placeholder="Casey, Peter" /></Field>
          </Group>

          <Group title="Content setup — floor">
            <Field label="Primary shooter">
              <select value={form.shooter} onChange={set('shooter')}>
                <option value="iphone">iPhone</option>
                <option value="dslr">DSLR</option>
                <option value="mirrorless">Mirrorless / Pro</option>
                <option value="webcam">Webcam</option>
                <option value="podcast">Podcast</option>
              </select>
            </Field>
            <Field label="Editing app"><input value={form.editingApp} onChange={set('editingApp')} placeholder="Premiere, Final Cut…" /></Field>
            <Field label="Gear" wide><input value={form.gear} onChange={set('gear')} placeholder="softbox, shotgun mic, gimbal" /></Field>
          </Group>

          <Group title="Referral — window wall">
            <Field label="Tech links (label | url)" wide><input value={form.tech} onChange={set('tech')} placeholder="My camera kit | https://…" /></Field>
            <Field label="Lifestyle links (label | url)" wide><input value={form.lifestyle} onChange={set('lifestyle')} placeholder="My Spotify | https://…" /></Field>
          </Group>

          <Group title="Style & companions">
            <Field label="Lighting">
              <select value={form.lighting} onChange={set('lighting')}>
                <option value="warm">Warm</option>
                <option value="neutral">Neutral</option>
                <option value="moody">Moody</option>
                <option value="bright">Bright studio</option>
              </select>
            </Field>
            <Field label="Pet">
              <select value={form.pet} onChange={set('pet')}>
                <option value="cat">Cat</option>
                <option value="dog">Dog</option>
                <option value="none">None</option>
              </select>
            </Field>
            <Field label="Palette (hex)" wide><input value={form.palette} onChange={set('palette')} placeholder="#E8C9A0, #C98A5E, #8FA98C" /></Field>
            <Field label="Materials"><input value={form.materials} onChange={set('materials')} placeholder="wood+linen" /></Field>
            <Field label="Signature props"><input value={form.props} onChange={set('props')} placeholder="latte mug, headphones" /></Field>
          </Group>

          <div className="room-form-foot">
            <button className="room-btn ghost" onClick={onReset}>Reset to sample</button>
            <button className="room-btn primary" onClick={onGenerate} disabled={generating}>
              {generating ? 'Generating…' : 'Generate with Rainy'}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="room-fgroup">
      <div className="room-fgroup-title">{title}</div>
      <div className="room-fgrid">{children}</div>
    </div>
  )
}
function Field({ label, wide, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <label className={`room-field${wide ? ' wide' : ''}`}>
      <span>{label}</span>
      {children}
    </label>
  )
}
