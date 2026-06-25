# Creator Room — Build Plan & Handoff

> **STATUS (2026-06-25, agent: Opus 4.8).** This plan came from a 13-agent research
> workflow. Backend = `src/comms-service/` (Creator Room HTTP API, runs on :8787;
> NOT `src/python-service/`, which is the team's MCP service on :9000). Frontend =
> `src/canvas-ui/` (`lib/creatorRoom.ts`, `components/{CreatorRoom,Onboarding}.tsx`).
>
> **DONE this session (committed):**
> - **Phase 1 — clay aesthetic preset** (`creatorRoom.ts` `ROOM_DOC`): AgX tone
>   mapping + EffectComposer (GTAO ambient occlusion → soft bloom → SMAA) +
>   clay materials. The 3D room reads as soft clay, not greybox.
> - **Phase 2 — image prompt upgrade** (`creator_image.py`): per-hex palette,
>   foreground/mid/background depth, color negatives, stable character clause.
> - **Phase 3 — onboarding** (`Onboarding.tsx` + `/api/creator-room/autofill` +
>   `creator_autofill.py`): 3 questions (niche→vibe→name+pet) → LLM autofill →
>   generate. Auto-opens on first visit. Verified end-to-end.
>
> **NOT done — prioritized backlog for overnight agents (details in §5/§7 below):**
> - **P0 self-host three.js** (`public/vendor/three/…`) + repoint the importmap off
>   jsDelivr — the iframe sandbox has no `allow-same-origin`, so the CDN importmap
>   **breaks offline in the WKWebView**. The post-stack added several addon imports
>   (EffectComposer + passes), so vendor those too.
> - **P0 profile-hash cache** in comms-service (shared by image/autofill/layout).
> - **P3 kit-bashed GLB room** (Phase 4): CC0 prop curation + `/api/creator-room/layout`
>   (schema-constrained Claude chooser) + GLB composition in `ROOM_DOC`. The
>   interactivity headline — closes the aesthetic gap with the image.
> - **P4 optional** depth-displaced 2.5D "live photo" on IMAGE mode.
> - **Note:** autofill uses OpenAI `gpt-4o-mini` today (only an OpenAI key is
>   configured); it auto-prefers Claude when `ANTHROPIC_API_KEY` is set.

---

# Rainy Creator Room — Architecture Decision & Build Plan

**Author:** Lead architect synthesis · grounded in repo state (`src/canvas-ui`, `src/comms-service`) and the full research + adversarial verdict set.

---

## 1. RECOMMENDATION

Ship **two complementary modes behind the existing Image/3D toggle, with a third instant interactive layer in between** — and stop treating "the image" and "the 3D room" as rivals; they are a fidelity-vs-interactivity gradient and we want all three rungs.

- **IMAGE mode stays the DEFAULT hero** (`gpt-image-1`): it is the only thing today that hits the painterly clay bar, costs a few cents, and is already wired. We keep it and *upgrade* it (palette correctness, character consistency, fore/mid/background separation that pays off later).
- **The INTERACTIVE 3D mode becomes a curated CC0 kit-bashed diorama** rendered in **vanilla three.js inside the existing sandboxed iframe** (Candidate A), driven by a **schema-constrained Claude layout call** in the Comms Service. This is the convergent winner across every research cluster and every adversarial verdict: it is the *only* option that delivers genuine orbit + per-object hover/click/referral-hotspots (interactivity 9), maps deterministically onto the `CreatorProfile` (fidelity 9), costs ~$0 per room after a one-time cached layout call (cost 9), and is ~90% already built in `buildRoomDoc()`. The aesthetic gap (verdict: 7) closes by swapping **ACES→AgX**, adding the **N8AO→Bloom→DoF→Vignette→SMAA→AgX** post stack and **warm-tinted contact shadows**, and replacing procedural greybox primitives with re-hosted CC0 GLB props.
- **The improved procedural room (Candidate E) is the always-on default-fallback** that renders *instantly, offline, free* while GLBs/layout load — same code path, just upgraded lighting. It guarantees the 3D tab is never blank and never network-blocked in the WKWebView.

We explicitly **reject single-image-to-3D as the room** (Candidate B — fuses the diorama into one un-pickable blob, kills referral hotspots) and **reject Spline** (Candidate D — GUI-authored binary our overnight agents cannot extend). The **2.5D depth-displaced plane (Candidate C)** is a *tempting* near-zero-effort "live photo" win but is parked as an **optional Phase-2 polish on IMAGE mode**, not the interactive room, because it gives no per-object picking — and per-object referral hotspots are core monetizable product value. Simplest path to a high aesthetic *and* interactivity bar: **upgrade the clay PNG, upgrade the procedural room's lighting tonight, then layer curated GLBs + a constrained layout endpoint on top.**

---

## 2. INTERACTIVE 3D — exact tech & pipeline

### Engine & runtime shape
- **Vanilla three.js r0.169+ (WebGLRenderer)** authored as a **single self-contained HTML document** rendered in the existing `<iframe sandbox="allow-scripts allow-popups...">` in `CreatorRoom.tsx` (lines 218–224). **Not R3F at runtime** — R3F needs build-time transpile and cannot mount into a static export inside a srcdoc (confirmed by the comment in `creator_room.py` and verdicts B/E/F). The drei *concepts* (AccumulativeShadows, N8AO, SMAA) are the value; we reimplement/vendor them in vanilla. Keep `model-viewer` only as a possible zero-effort single-GLB fallback, never the foundation.
- **CRITICAL ROBUSTNESS FIX (do first):** today three.js loads from `cdn.jsdelivr.net` via importmap (`creatorRoom.ts` lines 235–238) while the sandbox has **no `allow-same-origin`** — this works online but **breaks offline in the WKWebView shell** (research + verdicts A/E/F all flag this). **Self-host `three.module.js` + the addons + N8AO** from the app's own static origin (`public/vendor/three/…`) and reference them by relative URL in the importmap. This removes the single biggest overnight-fragility risk.

### Assembly approach: kit-bash + constrained LLM layout (NOT geometry generation)
1. **Asset registry (build-time, CC0 ONLY):** curate ~30–50 GLB props from **Kenney Furniture Kit + Quaternius interiors/nature + KayKit characters/props**, pulled via the **Poly Pizza API at build time** (filter `license=CC0`), Draco/meshopt-compressed, re-hosted under `public/creator-room/props/<id>.glb`. Each prop gets a registry entry `{ id, zone, footprint, anchorTags[] }`. **Ship CC0 only** so we can re-serve to end users with zero attribution obligation. **Reject Synty** (no SaaS re-serve grant, 5-seat cap). Sloyd is a *server-side cached fill-in only* for rare missing props, never on the hot path.
2. **Layout call (Comms Service, cached):** `POST /api/creator-room/layout {profile}` → Claude (Haiku/Sonnet, **structured JSON / tool-schema constrained decoding**) returns **only** `{ props: [{ id (from fixed registry), zone, slot, rotation }], palette, lighting }`. The LLM **picks from the registry and snaps to predefined zone anchors/grid slots — never emits free coordinates**, so layout is deterministic, collision-free, 100% schema-valid. Validate server-side; **fall back to `DEFAULT_PROFILE` layout on any parse failure** so it never dead-ends. **Cache by profile hash** in Postgres/object storage → repeat loads instant & free (~sub-cent, ~1–3s first time).
3. **Compose in the iframe:** the document builds the **fixed skeleton** (cutaway walls, wood floor, ortho camera — reuse today's `buildRoomDoc` skeleton) then `GLTFLoader`s the registry GLBs into the five named `THREE.Group`s (`library/content/referral/style/companions`) at the resolved slots. The deterministic procedural room remains the **instant first paint** while GLBs stream in.

### Clay aesthetic preset — named passes + params (the ~80% that is lighting/AO/tonemapping)
Apply these exact changes to the iframe document (current values from `creatorRoom.ts` cited):

| Layer | Change | Params |
|---|---|---|
| **Tone mapping** | **ACES → AgX** (line 280: `ACESFilmicToneMapping`) — ACES crushes contrast and hue-shifts terracotta→yellow, sabotaging the warm palette | `renderer.toneMapping = THREE.AgXToneMapping; toneMappingExposure ≈ 1.0–1.12`. Keep `NeutralToneMapping` as a true-color toggle. |
| **Material** | Uniform clay base on all kit props | `MeshStandardMaterial`, `roughness 0.85–0.95`, `metalness 0` (drop the 0.02), `envMapIntensity ≈ 0.9`. Tiny `emissive` (~2–3% of base) to lift shadows like subsurface. **Avoid metalness > 0 (reads plastic).** |
| **IBL** | Keep **`RoomEnvironment` via PMREMGenerator** (line 285–286) — zero external HDRI, offline-safe, exactly right for the sandbox | `scene.environment` set, `scene.background` left as soft solid so diorama floats. |
| **AO (the #1 clay contributor)** | Add **N8AO** as the FIRST post pass (vendored inline, self-hosted) | `aoRadius ≈ 0.5–1.0` (scene ~10u), `distanceFalloff 1.0`, `intensity 2–3`, `color ≈ 0x2a1a10` (warm, not black), `halfRes:true`, quality Medium (reserve Ultra for screenshots). |
| **Soft contact shadows** | Replace the single hard key shadow with **warm-tinted accumulated/contact shadows** (vanilla reimpl of AccumulativeShadows for the static room; ContactShadows-style blurred plane if animating) | shadow color `≈ 0x3a2a1f` (warm), `opacity ≈ 0.9`, blur ~2.5–3. |
| **Polish (subtle)** | **Bloom → DoF (tilt-shift) → Vignette → SMAA** then **AgX LAST** | Bloom `intensity 0.4–0.6, luminanceThreshold 0.85, mipmapBlur`; DoF gentle tilt-shift `bokehScale 2–3` (sells the miniature scale); Vignette `offset 0.3, darkness 0.5`. **SMAA mandatory** — post disables MSAA. **Order is load-bearing: AO, Bloom, DoF, Vignette, SMAA, ToneMapping(AGX).** |
| **Geometry** | Keep **`RoundedBoxGeometry`** for any primitives (line 330) — rounded edges catch the soft highlight that reads as clay; enforce bevel/chamfer on any greybox fallback. |

### Interactivity
Already wired and kept: **OrbitControls** (orbit, polar-clamped so you can't go behind walls, gentle turntable auto-rotate honoring `prefers-reduced-motion`), **`THREE.Raycaster` per-mesh hover** (emissive highlight + scale), **click → `parent.postMessage({source:'rainy-room', type:'hotspot', link, id, zone})`** consumed by `CreatorRoom.tsx` (lines 123–135) → opens referral link via native bridge. Each clickable prop maps to a referral link/zone — the monetizable hotspot system that *only* this candidate delivers cleanly. Drag-to-rearrange reachable later via pointer raycast + plane-constrained move. Cap **5–8 props/room**, GPU-instance repeats (books, plants), lazy-load by zone.

---

## 3. IMAGE MODE — keep & improve

**Keep `gpt-image-1` as the default hero.** It is the aesthetic bar the 3D mode is chasing; do not replace it. Targeted upgrades to `creator_image.py`:

1. **Color correctness (highest ROI):** the prompt already fights monochrome/sepia (lines 94–98) — good. Add **explicit per-hex palette injection** ("dominant accents: `#E8C9A0` cream, `#C98A5E` terracotta, …") and a hard negative on "desaturated, sepia, monochrome, muddy." This is the most common failure mode for clay renders.
2. **Character/avatar consistency:** the avatar is described inline (lines 81–83). To make *the same creator* recur across regenerations, (a) pin a **seed/`user` param** where supported, and (b) factor the character description into a **stable, profile-hashed sub-prompt** so re-renders of the same profile keep the same avatar features. Validate the clay character specifically — research flags humans as the weakest clay subject.
3. **Fore/mid/background separation:** prompt for *clear depth layering* (foreground character/props, mid-floor rig, back-wall library) and a clean cutaway. This costs nothing now and **unlocks the optional Candidate-C depth-displaced "live photo"** later for free.
4. **Caching:** add **profile-hash caching server-side** (today it's base64-in-localStorage which the code itself warns blows quota). Same cache layer the layout/3D path needs.
5. Keep Claude prompt-refinement (`_refine_with_claude`) as best-effort; it already degrades gracefully.

---

## 4. ONBOARDING FLOW — replace the big intake form

Research is decisive: **decouple "questions asked" from "fields filled."** The current `CreatorRoom.tsx` form exposes ~30 fields across 6 groups (the big-form trap). Replace with a **3-question, one-screen-at-a-time (Typeform-style) flow that ends in an LLM-autofill + editable review + generate moment.** Measured: conversational one-at-a-time ≈ 13.85% vs ≈ 4.53% single-page completion; >6 questions drops below 50%.

**The questions (one full-bleed screen each):**
1. **Q1 — NICHE** (free text + 5–6 suggestion chips: *tech & lifestyle vlogs, cooking, fitness, gaming, beauty, DIY*). Chips defeat blank-box paralysis.
2. **Q2 — VIBE** (multi-select chips, max 3, pre-checked to a sensible default: *cozy / warm / minimal / moody / playful / clean*).
3. **Q3 — PERSONAL TOUCH** (one combined screen: name + pet `cat/dog/none`) — cheap to ask, huge diorama warmth.

Then a single CTA: **"Build my room."**

**LLM autofill step:** as soon as Q1+Q2 are set, **optimistically prefetch** `POST /api/creator-room/autofill {niche, vibe, name, pet}` → Claude (Haiku/Sonnet, **structured output / tool schema mirroring the `CreatorProfile` interface** in `creatorRoom.ts` so it cannot drift) fills the other ~27 fields (reads/shows/roleModels/interests, shooter+gear+editingApp, referral hotspots, palette+lighting+materials, props). **Seed the prompt with `DEFAULT_PROFILE` as a one-shot example** so output stays in-aesthetic; **validate server-side; hard-fall back to `DEFAULT_PROFILE` on parse failure** so onboarding never dead-ends. Sub-cent, ~1–3s.

**The generate moment:** show an editable **"Here's your studio"** review card — collapsed sections (progressive disclosure) the user can expand to tweak; **never silently commit** (research is explicit: AI prefill must be inspectable + editable). One-tap **"Regenerate"**. On confirm → existing image/3D generate flow. **Run autofill *during* Q3 and play a choreographed "room assembling" reveal to mask the ~20s `gpt-image-1` latency.**

**UI / motion:** **Framer Motion** for the flow (`AnimatePresence` for screen-to-screen, chip springs, review-card expand/collapse) — React-declarative, ~32KB. **GSAP only if** we actually build the celebratory "room assembling" reveal (don't ship both otherwise). Honor `prefers-reduced-motion` (cross-fade/instant), full keyboard operability (Enter advances, Tab through chips, Space toggles), `focus-visible`, native disclosure semantics for review sections. Keep a power-user **"or just describe yourself →"** single-prompt shortcut feeding the same `/autofill` endpoint.

---

## 5. IMPLEMENTATION PLAN — file-level, in build order

**Phase 0 — Robustness foundation (do tonight; unblocks everything, low risk)**
1. `src/canvas-ui/public/vendor/three/` — vendor `three.module.js` + `examples/jsm/{controls/OrbitControls,geometries/RoundedBoxGeometry,environments/RoomEnvironment}.js` + N8AO. 
2. `src/canvas-ui/lib/creatorRoom.ts` (`ROOM_DOC`, lines 235–238) — repoint the importmap from `cdn.jsdelivr.net` to **relative `/vendor/three/…`** URLs. Offline-safe in WKWebView.
3. `src/comms-service/` — add a tiny **profile-hash cache** helper (`cache.py`: `sha256(canonical_json(profile))` → Postgres/object-storage get/put). Reused by image, layout, autofill.

**Phase 1 — Clay aesthetic upgrade to the procedural room (Candidate E polish; biggest aesthetic-per-effort)**
4. `src/canvas-ui/lib/creatorRoom.ts` — **line 280 `ACESFilmicToneMapping` → `AgXToneMapping`**; drop `metalness 0.02 → 0` and bump `roughness`; warm-tint the key shadow color.
5. Same file — add the **EffectComposer post stack** to `ROOM_DOC`: `N8AO → Bloom → DoF(tilt-shift) → Vignette → SMAA → AgX` with params from §2; vendored inline. Verify FPS in WKWebView (halfRes AO, Medium quality).
6. `src/comms-service/creator_room.py` (`SYSTEM_PROMPT`, lines 74–77) — update the clay instructions to match (AgX, post stack, warm AO) so Claude-generated docs inherit the upgraded look; switch its CDN refs to self-hosted too.

**Phase 2 — Image mode upgrade (cheap, parallelizable)**
7. `src/comms-service/creator_image.py` (`build_prompt`) — per-hex palette injection, sepia/monochrome negatives, stable profile-hashed character sub-prompt, explicit fore/mid/back separation; add seed/`user` param in `generate_room_image`. Wire `cache.py`.

**Phase 3 — Autofill onboarding (the UX leap)**
8. `src/comms-service/creator_autofill.py` (new) + `app.py` — `POST /api/creator-room/autofill {niche,vibe,name,pet}` → Claude structured output → validated `CreatorProfile`; one-shot `DEFAULT_PROFILE`; fallback on failure; cached.
9. `src/canvas-ui/components/Onboarding.tsx` (new) — 3-screen Typeform flow (Framer Motion) + editable "Here's your studio" review card + "Build my room". Add `autofillProfile()` to `creatorRoom.ts` (mirrors `generateRoomImage`). Replace the big `room-form` block in `CreatorRoom.tsx` (lines 256–318) with the review card; keep advanced fields under progressive disclosure.

**Phase 4 — Kit-bashed GLB 3D room (the interactivity headline)**
10. Build-time script `src/canvas-ui/scripts/curate-props.ts` — Poly Pizza API (`POLY_PIZZA_API_KEY`, CC0 filter) → download + Draco-compress → `public/creator-room/props/` + `props-registry.json`.
11. `src/comms-service/creator_layout.py` (new) + `app.py` — `POST /api/creator-room/layout {profile}` → Claude tool-schema constrained `{props,palette,lighting}`, registry-validated, cached, `DEFAULT_PROFILE` fallback.
12. `src/canvas-ui/lib/creatorRoom.ts` — extend `ROOM_DOC` to `GLTFLoader` registry props into the five `THREE.Group`s at resolved slots; procedural room stays the instant first paint; `buildRoomDocFromLayout(profile, layout)`.

**Docs (CLAUDE.md rule 4):** record decisions in `docs/DECISIONS.md`; reconcile `knowledge-base/canvas/creator-room.md`; flag the divergence that room endpoints live in `src/comms-service`, **not** `src/python-service` (frontend `apiBase()` already points at comms — keep it there).

---

## 6. REJECTED ALTERNATIVES

- **B — single-image-to-3D (Tripo/Meshy) as the room:** fuses the diorama into one un-pickable textured blob, loses the clay look and all per-object referral hotspots. *(Salvage: one hero prop/avatar only.)*
- **C — depth-displaced 2.5D plane as the interactive room:** beautiful but no per-object hover/click; parked as optional Phase-2 "live photo" polish on IMAGE mode, not the room.
- **D — Spline template scene:** proprietary GUI-authored binary; "data-driven swaps" can only move pre-built objects, can't add/recolor; our overnight agents can't author or extend it; +544KB gz runtime + WASM breaks offline WebView.
- **F — Claude-generated three.js per profile as primary:** ~$0.30–$1.50 and 30–90s per room, non-deterministic, only regex-validated; keep as an opt-in "remix" cached by profile hash, not the default.
- **Synty kits:** no SaaS/web re-serve license grant, 5-seat cap — legal trap; CC0 kits + good rendering match the look.
- **R3F at runtime / WebGPU now:** R3F can't transpile into a static-export srcdoc; R3F WebGPU support incomplete in early 2026 — stay on WebGLRenderer.

---

## 7. RISKS + OVERNIGHT BACKLOG

**Open risks (with mitigations):**
- **Offline CDN dependency (highest):** the jsDelivr importmap breaks in the WKWebView with the current `allow-scripts`-only sandbox. → **Self-host three.js (Phase 0).** Do this before anything else.
- **Aesthetic ceiling of kit/primitives:** even fully tuned, hand-coded primitives read "toy/blocky" vs the painterly PNG, and the clay *character* is hardest. → Keep IMAGE mode as hero; use curated GLB character (KayKit) over primitives; the character may stay a flat clay billboard if 3D disappoints.
- **Autofill quality = the whole UX:** generic/cringe fills feel canned. → `DEFAULT_PROFILE` one-shot, schema mirroring `CreatorProfile`, vibe-biased, one-tap regenerate, always editable.
- **Layout determinism:** free-form coords cause overlaps/floating props. → LLM is a *chooser* (registry id + zone slot only), schema-constrained, cached per hash.
- **Latency stacking** (autofill 1–3s + image ~20s): → prefetch autofill during Q3 + choreographed reveal to mask.
- **License hygiene:** ship **CC0 only**; any CC-BY requires a visible attribution panel; record terms in `DECISIONS.md`. Never call Poly Pizza/Sketchfab live from the client — curate at build time, re-host.
- **WKWebView perf:** post stack + many GLBs can jank on integrated GPUs. → halfRes AO, Medium quality, temporal accumulation for the static room, ContactShadows fallback on weak GPUs, cap props, instance repeats. **Test FPS in WKWebView specifically.**
- **Generated-doc safety (Candidate F path):** unvalidated JS ships silently. → headless smoke-test the doc before caching/serving.

**Prioritized overnight backlog (agents can parallelize):**
1. **P0** Self-host three.js + addons + N8AO; repoint importmap (Phase 0.1–0.2). *Unblocks offline + all post work.*
2. **P0** Add `cache.py` profile-hash cache to Comms Service (Phase 0.3). *Shared by all three endpoints.*
3. **P1** ACES→AgX + warm AO + EffectComposer post stack in `ROOM_DOC` + mirror in `creator_room.py` SYSTEM_PROMPT (Phase 1). *Biggest aesthetic-per-effort; verify WKWebView FPS.*
4. **P1** Image-mode prompt upgrade: palette hexes, sepia negatives, stable character sub-prompt, fore/mid/back separation, seed, caching (Phase 2).
5. **P2** `/autofill` endpoint + 3-screen Framer-Motion onboarding + editable review card; retire the big form (Phase 3).
6. **P3** Build-time CC0 prop curation script + registry; `/layout` constrained endpoint; GLB composition in `ROOM_DOC` (Phase 4).
7. **P4 (optional)** Candidate-C depth-displaced "live photo" on IMAGE mode (Depth Anything V2 in Comms Service, depth PNG inlined as a 2nd texture, orbit clamped to a few degrees).
8. **Continuous** Update `docs/DECISIONS.md` + `knowledge-base/canvas/creator-room.md`; reconcile the `comms-service` vs `python-service` endpoint divergence.

**Key files to touch:** `src/canvas-ui/lib/creatorRoom.ts` (importmap + `ROOM_DOC` clay preset + GLB composition), `src/canvas-ui/components/CreatorRoom.tsx` (replace form with review card), new `src/canvas-ui/components/Onboarding.tsx`, new `src/canvas-ui/public/vendor/three/` + `public/creator-room/props/`, `src/comms-service/{app.py, creator_image.py, creator_room.py}` + new `creator_autofill.py`, `creator_layout.py`, `cache.py`.