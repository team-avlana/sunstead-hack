/**
 * Creator Room — image-generation parameters + prompt builder.
 *
 * The wizard (CreatorWizard.tsx) collects these params, `buildImagePrompt`
 * fills the placeholder prompt (docs/CREATOR_ROOM_IMAGE_PROMPT.md), and
 * `buildPayload` assembles `{ params, prompt, aspectRatio, avatarPhoto }` to send
 * to the Python service's image endpoint. `requestRoomGeneration` is a STUB —
 * the cofounder wires the real POST; today it only persists/logs the payload so
 * the wizard is ready to trigger generation without firing it.
 */

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

// ---- payload + (stubbed) trigger -------------------------------------------

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

/**
 * STUB — the cofounder will implement the real POST to the Python service image
 * endpoint (prompt + optional avatar photo → generated room image). For now we
 * persist + log the payload so the wizard is fully wired and ready to trigger.
 */
export async function requestRoomGeneration(payload: RoomGenerationPayload): Promise<void> {
  // TODO(cofounder): POST { prompt, aspectRatio, avatarPhoto } to the image
  // endpoint and stream back the generated room image; persist + show it.
  if (typeof window !== 'undefined') {
    const slim = { ...payload, avatarPhoto: payload.avatarPhoto ? { name: payload.avatarPhoto.name, dataUrl: '(omitted)' } : undefined }
    try {
      window.localStorage.setItem('rainey:room:lastBrief', JSON.stringify(slim))
    } catch {
      /* quota — fine */
    }
    // eslint-disable-next-line no-console
    console.info('[Rainey] Room brief ready (generation not wired yet):', slim)
  }
}
