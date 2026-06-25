# Creator Room Kit — parameterized, hand‑authored 3D rooms

**Status:** concept / plan, 2026‑06‑25. **Supersedes** the earlier "weather/Creative Climate" framing —
the product is **Rainey** (a **reindeer** motif, *not* rain). **Time‑of‑day lighting is parked**
(revisit later). Reads: `src/canvas-ui/lib/creatorRoom.ts`, `docs/CREATOR_ROOM_PLAN.md`,
`docs/DECISIONS.md` (D27–D36).

---

## 0. Goal

Generate a **really aesthetic clay room for every creator** — like the cozy‑isometric reference
render — from a **parameterized, hand‑authored kit**, not one‑off generation. The lighting and material
language (AgX + GTAO + soft IBL, already in `buildRoomDoc`) carry the aesthetic; the *kit* carries the
variety. Start with a small **base set** and expand.

> The reference image's reindeer figurine on the shelf is **Rainey, the mascot** — bake it into the
> fixed skeleton as a signature object.

---

## 1. The model: a combinatorial kit (the one true idea)

Variety is **combinatorial**, not generative:

```
room = avatar  ×  roomType  ×  { propVariant per zone }
```

- **Avatars** — the creator, seated/filming. Variants: skin, hair, outfit, pose, pet. *(This is the
  biggest missing asset today — the current room has no person.)*
- **Room types** — the shell + palette + materials mood (cozy‑wood, minimal‑white, studio‑moody, …).
- **Per‑zone prop variants** — each zone draws from a small pool:
  - **library** (back wall): shelf styles, books, frames, plants, the Rainey figurine
  - **desk / content**: desk vs lounge‑chair‑with‑laptop, camera rig, softbox, mic, monitor
  - **filming area**: tripod, phone rig, key light, teleprompter
  - **table**: round/rect, chairs, laptops, mugs
  - **ambient lights**: pendant, paper lantern, floor lamp, string lights (always present — see §3)

Everything hangs off a **manifest** so primitives now and GLBs later are interchangeable:

```ts
// src/canvas-ui/lib/roomKit.ts  (NEW)
interface KitAsset {
  id: string
  zone: 'library' | 'content' | 'filming' | 'table' | 'ambient' | 'avatar'
  build: (ctx: BuildCtx) => THREE.Object3D   // procedural builder…
  glb?: string                               // …or a self-hosted GLB to load instead
  variants?: Record<string, unknown>         // skin/hair/outfit, colorways, sizes
  anchor: [number, number, number]           // where it sits in the fixed skeleton
  animate?: (obj: THREE.Object3D, t: number) => void // idle motion (see §3)
}
interface KitManifest { avatars: KitAsset[]; roomTypes: RoomType[]; props: KitAsset[] }
```

The composition step picks one option per slot (deterministically from the profile, or by the
creator's pick — see §4) and assembles the room. **The skeleton stays fixed; only the payload varies**
(this is already the D27 contract — we're just widening the payload into a real kit).

---

## 2. Base set for v1 (start small, expand)

Per your scope — **shelf, window, desk, avatar, table, ambient lights**. Status today:

| Asset | Today in `creatorRoom.ts` | v1 work |
|---|---|---|
| Room shell + window | ✅ shell + side‑wall window | keep; window stays a fixed fixture |
| **Shelf** (library) | ✅ back‑wall shelves + books/frames/plant | keep; add 1–2 shelf style variants |
| **Desk / filming** | ✅ table‑laptop, tripod, softbox | add a **lounge chair** (ref pose) |
| **Avatar** | ❌ *none* | **NEW — the headline addition** (seated, headphones, laptop; skin/hair/outfit variants) |
| **Table** | ✅ round table + laptops + mug | keep |
| **Ambient lights** | ✅ paper lantern + glow + pendant | keep; guarantee in every room (§3) |
| **Rainey reindeer** | ◑ a generic "deer‑ish token" | **promote to the signature mascot** (glowing nose) |

Everything else in the current room (sofa, kitchen props, etc.) is optional — fine to keep or trim to a
cleaner base later.

---

## 3. Animation system (you asked for component animations)

Add an `animators[]` list advanced once per frame from a `THREE.Clock`, gated by
`prefers-reduced-motion`. Each asset can register subtle idle motion:

- **Avatar** — breathing (torso scale), micro head‑bob, hands "typing."
- **Rainey reindeer** — softly pulsing nose, slow look‑around.
- **Ambient lights** — gentle emissive flicker (lantern/pendant) for a candle‑like life.
- **Plants** — slow leaf sway. **Pet** — breathing. **Screen** — subtle timeline flicker.

Keep amplitudes tiny — the room should feel *alive and occupied*, never busy. (Camera auto‑rotate is
already there; this adds life *within* the diorama.)

---

## 4. Producing the assets — the honest part

**Capability boundary:** I can't emit binary **GLB/GLTF** meshes or run a text→3D model from here. What
I *can* do: write **procedural three.js assets** (real, runnable, offline), build the **manifest +
loader**, and generate the **image/text prompts** to feed an image→3D tool or an artist. So:

| Route | Fidelity | Cost / deps | Who |
|---|---|---|---|
| **A. Procedural three.js** (clay primitives) | good, stylized | free, offline, in‑repo | **I build it now** |
| **B. AI image→3D GLB** (Meshy, Rodin, Luma Genie, Tripo) | **ref‑quality** | paid, your account/keys | you run it; prompt pack below |
| **C. Curated CC0 GLB** (Quaternius, Kenney, Poly Pizza) | decent | free, license curation | quick to assemble |
| **D. Commission an artist** | highest | $$$, slow | later |

**Recommendation:** **A now** (ships this session — gives you avatars to *pick* immediately and a great
offline fallback) **+ B for the hero‑fidelity props**, both behind the **same manifest** so swapping a
primitive for a GLB is a one‑line change per asset. C is a good stopgap for props you don't want to
hand‑model.

> **Prerequisite for B/C in the native shell:** three.js + `GLTFLoader` must be **self‑hosted** from
> `/vendor/three/` (the doc currently loads three from a CDN importmap — fine on web, breaks offline in
> WKWebView per `knowledge-base/canvas/creator-room.md`). Fold this in when we add the loader.

### Image‑prompt pack (route B/C — one object each, consistent style)

Shared style suffix for every prompt:
> *"…soft clay 3D render, rounded edges, matte finish, subtle ambient occlusion, warm soft studio
> lighting, isometric 3/4 view, single object centered on a plain off‑white background, no text, PBR,
> game‑ready low‑poly."*

- **Avatar:** "a friendly young content creator sitting cross‑legged in a lounge chair, over‑ear
  headphones, a laptop on their lap, brown tee, dark curly hair, gentle smile" + suffix. *(Generate 3–4
  skin/hair/outfit variants.)*
- **Shelf:** "a wall‑mounted wooden floating shelf with a few books, a small framed photo, a potted
  trailing plant, two ceramic vases" + suffix.
- **Desk / lounge chair:** "a mid‑century lounge chair in tan leather with wooden legs" + suffix.
- **Table:** "a small round light‑oak dining table with two simple wooden chairs and a laptop" + suffix.
- **Window:** "a cream double‑casement window in a rounded wall, looking out on tiny pastel rooftops" +
  suffix.
- **Ambient lights:** "a white PH‑style pendant lamp" / "a round paper‑lantern floor lamp glowing warm"
  + suffix.
- **Rainey (mascot):** "a tiny cute reindeer figurine, warm brown clay, small glowing red nose, little
  antlers, friendly" + suffix.

---

## 5. Manifest / loader (the GLB drop‑in path)

When you have GLBs: a `KitAsset.glb` loads via `GLTFLoader` into the asset's zone anchor (instead of
running `build`); the rest of the pipeline is unchanged. Notes: self‑host (above), GPU‑instance repeats
(books, plants), lazy‑load by zone, keep visible prop count modest, hold the 60 fps budget
(`FEASIBILITY.md`).

---

## 6. Parked / later

Time‑of‑day window lighting cycle (the "golden hour / night lamps" idea), a 2D atmosphere layer, and
per‑niche "secret‑location" room types. All compatible with this kit; revisit after the base kit lands.

---

## 7. Open decisions (for Adrian)

1. **Asset route** — A only for now, or A + start B (which tool: Meshy / Rodin / Luma / Tripo)?
2. **Brand rename** — do we rename "Rainy" → "Rainey" repo‑wide (localStorage keys, postMessage
   source, brand mark), or keep the code as‑is for now?
3. **Base‑kit trim** — keep the current dense room and just add the avatar, or slim it to the clean
   six‑asset base set?
4. **Pick UX** — in‑room variant cycler (shipping a first version this session), or a React‑side
   chooser in `CreatorRoom.tsx`?
