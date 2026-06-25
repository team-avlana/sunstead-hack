# Creator Room — image generation spec (parameters + prompt)

**Goal:** generate the Creator Room as a single **2D clay‑render image** from a parameterized prompt
that **always** contains the required components (window, library shelf, recording setup, avatar,
ambient lamps) in fixed areas, while the **room design + personalization vary**. Hand to whichever
image model wins (Gemini Flash Image / gpt‑image‑1 / Midjourney / Flux…).

**Wizard UX:** keep every question light and optional‑where‑possible — offer preset chips, allow a
free‑text "other", and let people skip (we autofill from the niche). Nothing is required except
`creator_type`, `niche`, `room_design`, and the avatar.

---

## 1. Input parameters (the wizard)

| # | Question | key | type · options |
|---|---|---|---|
| 1 | "What kind of creator are you?" | `creator_type` | **Content Creator** / **Filmmaker** / **Pro Cinematographer** — *scales the gear in the room* (see below) |
| 2 | "What do you create?" | `niche` | chips (cooking, gaming, beauty, tech, travel, music, fitness, DIY…) **+ free text** |
| 3 | "Pick your vibe" | `vibe` | chips, up to 3 (cozy, warm, minimal, moody, playful, clean, bold, dreamy) **+ optional free text** |
| 4 | "Choose a room style" | `room_design` | Scandinavian / Japandi / cozy cottage / minimal white / mid‑century modern / industrial loft / boho / dark studio / plant‑filled / pastel kawaii |
| 5 | "Make your avatar" | `avatar` | **(a) upload a photo** of yourself → stylized into the clay character, **or (b) one‑line description** |
| 6 | "What's on your shelf?" *(optional, autofills)* | `interests`, `books`, `shows_films`, `role_models` | free text / chips — used only as shelf suggestions |
| 7 | "Pick a companion" | `companion` | one pick — a **pet** (cat / dog / bird / none) **or** a **personal prop** (guitar, skateboard, vinyl player, plant…) |

**Always fixed — never asked:** the cozy isometric clay cutaway style, the **cozy warm lighting**, the
**window**, the **library shelf** (same area every time), the **recording setup** (from `creator_type`),
the **persistent style‑matched ambient lamps** (built so we can later "turn them on" at night), and the
**Rainey reindeer** figurine on the shelf.

### `creator_type` → `{{recording_setup}}` (the gear tier)
| tier | `{{recording_setup}}` expands to |
|---|---|
| **Content Creator** | a smartphone or compact mirrorless camera on a small tripod, a ring light, and a clip‑on mic — a simple, approachable setup |
| **Filmmaker** | a Sony FX3 cinema camera on a sturdy tripod with a gimbal nearby, an LED softbox panel, a shotgun mic on a boom arm, and a small field monitor |
| **Pro Cinematographer** | a high‑end ARRI Alexa or RED cinema camera on a professional tripod/dolly, large HMI + softbox film lights, a follow‑focus and matte box, and a director's monitor |

---

## 2. The prompt (placeholders in `{{…}}`)

```text
Isometric clay-render of a cozy content creator's studio — a single small room shown as a 3/4
top-down CUTAWAY "dollhouse", soft 3D clay aesthetic: rounded edges, matte surfaces, warm soft
global illumination, gentle ambient occlusion in the corners, a subtle tilt-shift miniature
depth-of-field, on a plain off-white background, perfectly centered, ultra-clean, no text. Always a
warm, cozy mood.

FIXED LAYOUT — always include ALL of these, in these same areas:
• ROOM SHELL: two cream rounded walls meeting at the back + a light wooden-plank floor and a soft
  rug, in a {{room_design}} style with a {{vibe}} feel.
• WINDOW (right-hand wall, ALWAYS present): a window with soft daylight spilling in.
• LIBRARY SHELF (back/left wall, ALWAYS in this same area): a wall-mounted wooden shelf holding
  {{books}} as colorful book spines, small objects suggesting {{interests}}, small framed posters of
  {{shows_films}}, tiny figurines of {{role_models}}, a potted plant, and a small brown REINDEER
  figurine (the "Rainey" mascot).
• CONTENT RECORDING SETUP (floor, center-front, ALWAYS present): {{recording_setup}}, facing the seat.
• AVATAR (seated at the recording setup, ALWAYS present, working/filming): {{avatar_clause}}.
• AMBIENT LIGHTS (ALWAYS present, persistent fixtures that match the room): a couple of style-matched
  lamps — e.g. a floor lamp plus a pendant or table lamp — placed naturally; soft in this daytime
  render, but built as real lights that could glow warm at night.
• COMPANION & DETAILS: {{companion}}, plus a few small personal touches that fit the style.

STYLE LOCK: keep the SAME isometric camera angle every time; one cohesive room; soft warm shadows;
miniature diorama feel. Absolutely NO text, letters, watermark, UI, or any extra people beyond the
single avatar.
```

- `{{avatar_clause}}` — **photo mode:** *"stylize the person in the attached reference photo as the
  clay character — keep their likeness (face, skin tone, hairstyle, glasses, clothing style), rendered
  in the soft clay look"* · **description mode:** *"a stylized clay character: {{avatar_description}}"*
- `{{companion}}` — e.g. *"a ginger cat curled up on the sofa"* or *"a vintage guitar leaning in the corner"*.
- Empty list fields (`{{books}}`, etc.) → drop the clause.

**Negative prompt** (models that take one): `text, letters, words, watermark, signature, UI, multiple
rooms, extra people, crowd, blurry, photorealistic photo, harsh shadows, cluttered, distorted
proportions, lowres`. **Format:** landscape **3:2**. **Consistency:** fix a **seed**, change only
`{{room_design}}` to demo "same skeleton, many designs".

---

## 3. Sample — ready to paste (Gemini Flash Image)

A cozy **Content Creator** (tech/lifestyle, with a cat):

```text
Isometric clay-render of a cozy content creator's studio — a single small room shown as a 3/4
top-down cutaway "dollhouse", soft 3D clay aesthetic: rounded edges, matte surfaces, warm soft global
illumination, gentle ambient occlusion, subtle tilt-shift miniature depth-of-field, plain off-white
background, centered, ultra-clean, no text. Warm cozy mood.

FIXED LAYOUT — include ALL of these:
• ROOM SHELL: two cream rounded walls + a light wooden-plank floor and a patterned rug, Scandinavian
  style with a cozy minimal feel.
• WINDOW (right wall): a window with soft daylight spilling in.
• LIBRARY SHELF (back/left wall): a wooden shelf with a few colorful book spines, small objects
  suggesting photography, coffee and travel, a small framed poster, a tiny figurine, a potted plant,
  and a small brown reindeer figurine (the "Rainey" mascot).
• CONTENT RECORDING SETUP (floor, center-front): a compact mirrorless camera on a small tripod, a
  ring light, and a clip-on mic, facing the seat; a laptop open to an editing timeline.
• AVATAR (seated, editing on the laptop): a stylized clay character — a woman with tan skin and
  shoulder-length wavy dark-brown hair, wearing a cream knit sweater, headphones around her neck.
• AMBIENT LIGHTS: a paper-lantern floor lamp and a white pendant lamp matching the room — soft in
  daylight, built to glow warm at night.
• COMPANION & DETAILS: a ginger cat curled up on a small sofa, plus a latte mug and a couple of plants.

STYLE LOCK: isometric camera angle, one cohesive room, soft warm shadows, miniature diorama feel. NO
text, watermark, UI, or extra people. Landscape 3:2.
```

**Swap the gear line to test the other tiers (same room otherwise):**
- *Filmmaker* → `a Sony FX3 cinema camera on a sturdy tripod with a gimbal nearby, an LED softbox panel, a shotgun mic on a boom arm, and a small field monitor`
- *Pro Cinematographer* → `an ARRI Alexa cinema camera on a professional tripod/dolly, large HMI and softbox film lights, a follow-focus and matte box, and a director's monitor`

**Using a photo with Gemini:** attach the person's photo and replace the AVATAR line with → *"stylize the
person in the attached photo as the seated clay character, keeping their likeness (face, skin tone,
hairstyle, glasses, clothing), in the soft clay style."*

## 4. QA checklist (each render)
window ✔ · library shelf in its area ✔ · reindeer on the shelf ✔ · recording gear matching `creator_type` ✔ · avatar matches the input ✔ · style‑matched ambient lamps ✔ · isometric cutaway, no text ✔
