/**
 * Creator Room — image-generation parameters + prompt builder.
 *
 * The wizard (CreatorWizard.tsx) collects these params, `buildImagePrompt`
 * fills the prompt (docs/CREATOR_ROOM_IMAGE_PROMPT.md), and `buildPayload`
 * assembles `{ params, prompt, aspectRatio, avatarPhoto }`. `requestRoomGeneration`
 * POSTs that to the python-service (POST /api/creators/{self}/room-image via
 * lib/api) and returns the URL of the generated room PNG.
 */

import { fetchSelfCreator, generateRoomImage, hasBackend, roomImageUrl } from '@/lib/api'

export type CreatorType = 'content-creator' | 'filmmaker' | 'pro-cinematographer'
export type AvatarMode = 'photo' | 'description'
export type CompanionKind = 'pet' | 'prop'
export type CompanionPet = 'cat' | 'dog' | 'bird' | 'none'

export interface CreatorRoomParams {
  creatorType: CreatorType
  niche: string
  vibe: string[] // up to 3 presets
  vibeExtra?: string // optional free text
  roomDesign: string
  avatarMode: AvatarMode
  avatarDescription: string // used in description mode (default: a man)
  avatarPhotoName?: string // filename only; the image bytes travel in the payload
  // library shelf suggestions (all optional — autofilled/omitted if blank)
  interests: string
  books: string
  showsFilms: string
  roleModels: string
  // companion — one pick: a pet OR a personal prop
  companionKind: CompanionKind
  companionPet: CompanionPet
  companionProp?: string
}

// ---- option lists (the wizard offers these as chips/cards) -----------------

export const NICHES = ['tech & lifestyle', 'cooking', 'fitness', 'gaming', 'beauty', 'travel', 'music', 'DIY & crafts']
export const VIBES = ['cozy', 'warm', 'minimal', 'moody', 'playful', 'clean', 'bold', 'dreamy']
export const ROOM_DESIGNS = [
  'Scandinavian', 'Japandi', 'Cozy cottage', 'Minimal white', 'Mid-century modern',
  'Industrial loft', 'Boho', 'Dark studio', 'Plant-filled', 'Pastel kawaii',
]
export const MAX_VIBES = 3

/** `creator_type` scales the recording gear that appears in the room. */
export const CREATOR_TYPES: { id: CreatorType; label: string; emoji: string; blurb: string; gear: string }[] = [
  {
    id: 'content-creator', label: 'Content Creator', emoji: '🎥',
    blurb: 'Phone or mirrorless + a ring light — simple & approachable',
    gear: 'a smartphone or compact mirrorless camera on a small tripod, a ring light, and a clip-on mic',
  },
  {
    id: 'filmmaker', label: 'Filmmaker', emoji: '🎬',
    blurb: 'Cinema camera (Sony FX3), softbox, boom mic',
    gear: 'a Sony FX3 cinema camera on a sturdy tripod with a gimbal nearby, an LED softbox panel, a shotgun mic on a boom arm, and a small field monitor',
  },
  {
    id: 'pro-cinematographer', label: 'Pro Cinematographer', emoji: '🎞️',
    blurb: 'ARRI / RED, HMI lights, follow-focus — the full rig',
    gear: "a high-end ARRI Alexa or RED cinema camera on a professional tripod/dolly, large HMI and softbox film lights, a follow-focus and matte box, and a director's monitor",
  },
]

export const COMPANION_PETS: { id: CompanionPet; label: string; emoji: string }[] = [
  { id: 'cat', label: 'Cat', emoji: '🐱' },
  { id: 'dog', label: 'Dog', emoji: '🐶' },
  { id: 'bird', label: 'Bird', emoji: '🐦' },
  { id: 'none', label: 'No pet', emoji: '🚫' },
]

/** Male avatar default (per product decision). */
export const DEFAULT_AVATAR_DESCRIPTION = 'a man with short dark hair and light stubble, wearing a cozy knit sweater'

export const DEFAULT_PARAMS: CreatorRoomParams = {
  creatorType: 'content-creator',
  niche: '',
  vibe: ['cozy', 'warm'],
  roomDesign: 'Scandinavian',
  avatarMode: 'description',
  avatarDescription: DEFAULT_AVATAR_DESCRIPTION,
  interests: '', books: '', showsFilms: '', roleModels: '',
  companionKind: 'pet',
  companionPet: 'cat',
}

// ---- prompt builder --------------------------------------------------------

const gearFor = (t: CreatorType) => (CREATOR_TYPES.find((c) => c.id === t) ?? CREATOR_TYPES[0]).gear

function avatarClause(p: CreatorRoomParams): string {
  if (p.avatarMode === 'photo') {
    return 'stylize the person in the attached reference photo as the clay character — keep their likeness (face, skin tone, hairstyle, glasses, clothing style), rendered in the soft clay look'
  }
  return `a stylized clay character: ${p.avatarDescription.trim() || DEFAULT_AVATAR_DESCRIPTION}`
}

function companionClause(p: CreatorRoomParams): string {
  if (p.companionKind === 'prop') return `${p.companionProp?.trim() || 'a personal prop'} as a personal touch`
  if (p.companionPet === 'none') return 'a few personal touches that fit the style'
  return `a ${p.companionPet} resting nearby`
}

function shelfClause(p: CreatorRoomParams): string {
  const parts = [
    p.books.trim() && `${p.books.trim()} as colorful book spines`,
    p.interests.trim() && `small objects suggesting ${p.interests.trim()}`,
    p.showsFilms.trim() && `small framed posters of ${p.showsFilms.trim()}`,
    p.roleModels.trim() && `tiny figurines of ${p.roleModels.trim()}`,
  ].filter(Boolean)
  const lead = parts.length ? parts.join(', ') : 'a few books and small objects'
  return `${lead}, a potted plant, and a small brown REINDEER figurine (the "Rainey" mascot)`
}

/** Build the full clay-render image prompt from the wizard params. */
export function buildImagePrompt(p: CreatorRoomParams): string {
  const vibe = [...p.vibe, ...(p.vibeExtra?.trim() ? [p.vibeExtra.trim()] : [])].join(', ') || 'cozy'
  return `Isometric clay-render of a cozy content creator's studio — a single small room shown as a 3/4 top-down CUTAWAY "dollhouse", soft 3D clay aesthetic: rounded edges, matte surfaces, warm soft global illumination, gentle ambient occlusion in the corners, a subtle tilt-shift miniature depth-of-field, on a plain off-white background, perfectly centered, ultra-clean, no text. Always a warm, cozy mood.

FIXED LAYOUT — always include ALL of these, in these same areas:
• ROOM SHELL: two cream rounded walls meeting at the back + a light wooden-plank floor and a soft rug, in a ${p.roomDesign} style with a ${vibe} feel.
• WINDOW (right-hand wall, ALWAYS present): a window with soft daylight spilling in.
• LIBRARY SHELF (back/left wall, ALWAYS in this same area): a wall-mounted wooden shelf holding ${shelfClause(p)}.
• CONTENT RECORDING SETUP (floor, center-front, ALWAYS present): ${gearFor(p.creatorType)}, facing the seat.
• AVATAR (seated at the recording setup, ALWAYS present, working/filming): ${avatarClause(p)}.
• AMBIENT LIGHTS (ALWAYS present, persistent fixtures that match the room): a couple of style-matched lamps — e.g. a floor lamp plus a pendant or table lamp — placed naturally; soft in this daytime render, but built as real lights that could glow warm at night.
• COMPANION & DETAILS: ${companionClause(p)}, plus a few small personal touches that fit the style.

STYLE LOCK: keep the SAME isometric camera angle every time; one cohesive room; soft warm shadows; miniature diorama feel. Absolutely NO text, letters, watermark, UI, or any extra people beyond the single avatar. Square 1:1 aspect ratio.`
}

// ---- payload + generation trigger ------------------------------------------

export interface RoomGenerationPayload {
  params: CreatorRoomParams
  prompt: string
  aspectRatio: '1:1'
  /** Present only in photo mode — base64 data URL of the uploaded face. */
  avatarPhoto?: { name: string; dataUrl: string }
}

export function buildPayload(params: CreatorRoomParams, avatarPhoto?: { name: string; dataUrl: string }): RoomGenerationPayload {
  return { params, prompt: buildImagePrompt(params), aspectRatio: '1:1', avatarPhoto }
}

/** Persist the room brief so it survives reloads and the no-backend fallback. */
function persistBrief(payload: RoomGenerationPayload): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      'rainy:room:lastBrief',
      JSON.stringify({
        ...payload,
        avatarPhoto: payload.avatarPhoto ? { name: payload.avatarPhoto.name, dataUrl: '(omitted)' } : undefined,
      }),
    )
    window.localStorage.setItem('rainy:room:profile', JSON.stringify(payload.params))
  } catch {
    /* quota — fine */
  }
}

/** `creator_type` → the backend's recording-setup key (image_gen._SETUP_MAP). */
const SHOOTER_FOR: Record<CreatorType, string> = {
  'content-creator': 'iphone',
  filmmaker: 'mirrorless',
  'pro-cinematographer': 'dslr',
}

const splitList = (s: string): string[] => s.split(',').map((x) => x.trim()).filter(Boolean)

/** Collapse the chosen vibe words to the backend's lighting bucket. */
function deriveLighting(vibe: string[]): string {
  const v = vibe.map((x) => x.toLowerCase())
  if (v.some((x) => x === 'moody' || x === 'dark')) return 'moody'
  if (v.some((x) => x === 'bright' || x === 'clean')) return 'bright'
  if (v.some((x) => x === 'warm' || x === 'cozy')) return 'warm'
  return 'neutral'
}

/**
 * Map the wizard's flat params to the backend `profile` shape that
 * image_gen._build_prompt reads (creator / library / content / style /
 * companions). Sent as a fallback alongside the ready-made `prompt`.
 */
export function paramsToProfile(p: CreatorRoomParams): Record<string, unknown> {
  return {
    creator: {
      niche: p.niche,
      vibe: [...p.vibe, ...(p.vibeExtra?.trim() ? [p.vibeExtra.trim()] : [])],
    },
    avatarDescription: p.avatarMode === 'description' ? p.avatarDescription : '',
    library: {
      interests: splitList(p.interests),
      reads: splitList(p.books),
      shows: splitList(p.showsFilms),
      roleModels: splitList(p.roleModels),
    },
    content: { shooter: SHOOTER_FOR[p.creatorType], gear: [] },
    style: { lighting: deriveLighting(p.vibe), materials: p.roomDesign },
    companions: {
      pet: p.companionKind === 'pet' ? p.companionPet : 'none',
      props: p.companionKind === 'prop' && p.companionProp ? [p.companionProp] : [],
    },
  }
}

export type RoomGenerationResult =
  | { ok: true; imageUrl: string }
  | { ok: false; reason: 'no-backend' | 'error' }

/**
 * Generate the Creator Room image on the python-service and return the URL of
 * the saved PNG. The wizard's prompt is used verbatim; the uploaded face (photo
 * mode) anchors the avatar likeness. Always persists the brief; returns
 * {ok:false} when no backend is configured or generation fails (the caller then
 * keeps the default room).
 */
export async function requestRoomGeneration(payload: RoomGenerationPayload): Promise<RoomGenerationResult> {
  persistBrief(payload)
  if (!hasBackend()) return { ok: false, reason: 'no-backend' }

  const self = await fetchSelfCreator()
  if (!self) return { ok: false, reason: 'error' }

  const res = await generateRoomImage(self.creator_id, {
    prompt: payload.prompt,
    profile: paramsToProfile(payload.params),
    avatarPhoto: payload.avatarPhoto?.dataUrl,
  })
  if (!res) return { ok: false, reason: 'error' }

  const url = roomImageUrl(self.creator_id, Date.now())
  return url ? { ok: true, imageUrl: url } : { ok: false, reason: 'error' }
}
