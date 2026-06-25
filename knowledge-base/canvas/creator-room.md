# Creator Room — the personalized hero

_Last updated: 2026-06-25_

The **Creator Room** is the canvas-ui Home-screen hero: a personalized clay-render
diorama of a content creator's world, driven by a short intake form. It has two
render modes; **Image is the default**, 3D is a secondary toggle.

## Design contract — fixed skeleton + variable payload

Five **zones**, constant in meaning, variable in contents (same template → infinite
rooms):

| Zone | Anchor | Injected per creator |
|---|---|---|
| `library`    | back wall    | books (reads), posters (shows), figurines (role models), plants, niche objects |
| `content`    | floor centre | camera+tripod sized to `shooter`, gear, desk laptop showing `editingApp` |
| `referral`   | window wall  | window, speaker→playlist, labeled gear box |
| `style`      | whole room   | palette, lighting mood, materials |
| `companions` | soft props   | pet, lamp, mug, headphones |

The `CreatorProfile` shape lives in `src/canvas-ui/lib/creatorRoom.ts`.

## Mode 1 — IMAGE (default)

A rendered clay-diorama **PNG** (character/avatar included) — matches the reference
style 1:1, which hand-coded 3D primitives cannot.

```
profile ─▶ build image prompt (Prompt A, deterministic; optional Claude refine)
        ─▶ OpenAI gpt-image-1  ─▶ data-URL PNG  ─▶ <img> hero
```

- Endpoint: `POST /api/creator-room/image` on `src/python-service`
  (`creator_image.py`). Needs `OPENAI_API_KEY`. **Anthropic can't output images**;
  Claude's only (optional) role is prompt-craft when `ANTHROPIC_API_KEY` is set.
- Knobs: `RAINY_IMAGE_SIZE` (default `1536x1024`), `RAINY_IMAGE_QUALITY`
  (`low|medium|high`, default `medium`).
- Default visual: a bundled **own-generated** sample (`public/creator-room/sample.png`)
  shown **blurred behind a "Generate" CTA** until a real image is rendered. On 503
  (no key) the UI keeps showing the sample.
- Verified end-to-end: the render adapts to the profile (shooter→camera/ring-light
  rig, pet type, palette, lighting). gpt-image-1 tends toward warm-mono unless the
  prompt explicitly demands varied color — the prompt does (see `creator_image.py`).

## Mode 2 — 3D (toggle)

A self-contained **three.js** document in a sandboxed `<iframe srcdoc>` (R3F can't
be transpiled at runtime in a static export; a self-contained doc *is* runnable
generated code and stays origin-isolated). Two sources:
- **Procedural** (`buildRoomDoc`) — instant, offline, deterministic, the fallback.
  Uses `RoomEnvironment` IBL + ACES tone mapping for a soft clay look.
- **Generated** — `POST /api/creator-room/generate` has Claude (Opus 4.8, streamed)
  write a bespoke doc.

iframe→host channel is `postMessage`: `{type:'ready'}` and
`{type:'hotspot', link, id, zone}` (host opens links; WebView routes via the native
bridge). three.js loads via a **jsDelivr importmap** (not esm.sh — esm.sh rewrites
addons' `import 'three'` and can load a duplicate instance).

## Wiring

- UI → service via `NEXT_PUBLIC_COMMS_API_URL` (e.g. `http://localhost:8787/api`).
- Service loads a local `.env` (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) via
  python-dotenv; CORS is permissive by default (tighten with `RAINY_ALLOWED_ORIGINS`).
- canvas-ui is a **static export** → all secrets/calls live in the Comms Service.

## Files
- `src/canvas-ui/lib/creatorRoom.ts` — profile model, `buildRoomDoc` (3D),
  `generateRoomDoc`, `generateRoomImage`, persistence, `SAMPLE_IMAGE`.
- `src/canvas-ui/components/CreatorRoom.tsx` — hero (image default + 3D toggle) + intake.
- `src/python-service/{app,creator_image,creator_room}.py` — endpoints.

## Roadmap
v1 image mode + procedural/generated 3D (done). Next: photo→avatar likeness,
per-project rooms, image variations/edits, GLTF model packs for the 3D mode.
See `docs/DECISIONS.md` D27–D34.

## Sources
- Build brief: "Creator Room — 3D Web Component Build Brief" (2026-06-25).
- OpenAI Images (`gpt-image-1`): https://platform.openai.com/docs/guides/image-generation
- three.js importmap: https://threejs.org/docs/#manual/en/introduction/Installation
