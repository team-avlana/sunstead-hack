# Brainstorm — ElevenLabs Feature Surface for Rainey

> Scoping doc. Captures **every plausible** ElevenLabs integration for the video
> preproduction assistant — full menu, not a committed roadmap. Pick from here later.
>
> **Status:** brainstorm / unscoped. No decisions made. See `docs/DECISIONS.md` when any
> of these graduate to "building."
>
> **Date:** 2026-06-25

---

## 0. Context — what we're integrating into

Rainey is a local-first video **preproduction** assistant. The agent (user's Claude client)
drives an MCP-over-HTTP server; a tldraw canvas renders artifacts backed by Postgres.

Integration anchors that already exist:

| Surface | What it is | ElevenLabs hook |
|---|---|---|
| `analyze_video` / `analyze_channel` | ingest + style-profile reference content | **Scribe v2** transcription/diarization |
| `get_style_profile` | derived creator voice/tone profile | feed TTS voice + music vibe selection |
| `create_artifact` / `update_artifact` | frames with `payload.elements[]` blocks (`text`, `video`, …) | **new block types**: `vo`, `music`, `sfx`, `dialogue` |
| canvas (tldraw projection) | renders artifacts; one frame → one flow | inline audio players on blocks |
| Creator Room + Rainey mascot rig | 3D room, avatar, idle animations | **voice agent** (Conversational AI 2.0) |
| `memory` | goals / audience / preferences | persist chosen voice IDs, music vibe, language |

**Architecture constraints to respect:** MCP = Streamable HTTP; DB = Postgres (single source
of truth); realtime = websocket change-signal → canvas re-pulls. Any ElevenLabs call belongs in
`src/python-service`, with generated audio stored/referenced and surfaced as artifact blocks —
never called directly from `canvas-ui`. **Do not build on** the deprecated `eleven_*_v1` models
(removed 2026-07-09).

---

## 1. ElevenLabs capability inventory (2026)

What's available to draw from, newest-first.

### 1.1 Eleven v3 — expressive TTS
- Most expressive model; voices that sigh, whisper, laugh, react.
- **Inline audio tags** via bracket notation: `[whisper]`, `[laughs]`, `[excited]`, `[sighs]`, etc.
- Natural-language audio **direction embedded in the script**.
- **Multi-speaker / dialogue** control with inline tags.
- 70+ languages, emotion + pacing control.

### 1.2 ElevenMusic / Music v2
- `model_id: music_v2`. **Chunk-based composition plans** (`GenerationChunk`, `AudioRefChunk`)
  → control over structure, pacing, arrangement (vs. prompt-only v1).
- Royalty-free music beds, intros/outros, stings.
- Endpoints: Generate / Stream / Generate-detailed / Upload music.

### 1.3 SFX v2 — text-to-sound-effects
- Generate whooshes, ambience, foley, transitions, UI sounds from a text prompt.

### 1.4 Scribe v2 — speech-to-text
- Transcription + **diarization** (`use_speaker_library` for batch).
- Accepts audio **and video** up to **5GB**.

### 1.5 Conversational AI 2.0 / Agents
- Real-time voice agents; `turn_v3` turn-detection (vs `turn_v2`).
- Workflows, guardrails, conversation evaluation, tool/secret (URL-auth) connections.

### 1.6 Dubbing
- Translate + re-voice existing video/audio across languages, preserving timing.

### 1.7 Image & video generation
- Newer additions to the media stack (lower priority for preproduction, noted for completeness).

### 1.8 Platform shape
- One API, one subscription across voice / music / SFX / transcription / agents.

---

## 2. Feature menu, by capability

Each item: **what it is**, **where it lands in the app**, rough **effort** (S/M/L), and **risk/notes**.

### 2.1 Voiceover & scripting (Eleven v3)

1. **Script-block "hear it" preview** — TTS-render a `text`/`vo` block so the creator hears pacing
   before shooting. *Lands:* `vo` block on canvas w/ audio player. *Effort:* M. *Notes:* highest
   creator value; core preproduction use.
2. **Audio-tag authoring helper** — agent inserts `[whisper]`/`[laughs]`/etc. into scripts and the
   preview honors them. *Lands:* `update_artifact` element patch. *Effort:* M.
3. **Voice picker tied to style profile** — choose/lock a voice ID per project from `get_style_profile`;
   persist in `memory`. *Effort:* S–M.
4. **Multi-speaker table read** — render dialogue scripts with distinct voices per character.
   *Lands:* `dialogue` block. *Effort:* M.
5. **Tone/emotion A/B** — generate 2–3 reads of the same line (calm vs. hyped) to compare. *Effort:* M.
6. **Multilingual scratch VO** — preview the script in another language (70+) for localization scoping.
   *Effort:* S (leverages dubbing/TTS).
7. **Hook/cold-open generator+preview** — agent drafts first-3-seconds hooks, each with an audio read.
   *Effort:* M.
8. **Pacing/read-time estimate** — use TTS duration to estimate segment length → timeline planning.
   *Effort:* S. *Notes:* cheap, useful for shot/segment budgeting.

### 2.2 Music (Music v2)

9. **Music-bed generator** — vibe prompt → background track as a `music` block. *Effort:* M.
10. **Intro/outro sting generator** — short branded stings from style profile. *Effort:* M.
11. **Chunk-plan arrangement** — expose `GenerationChunk`/`AudioRefChunk` for intro→build→drop
    structure matched to video segments. *Effort:* L. *Notes:* most powerful, most complex.
12. **Mood-matched scoring** — derive vibe from `analyze_video` of reference content → suggest matching beds.
    *Effort:* M.
13. **Royalty-free library per project** — generated tracks saved as reusable project assets. *Effort:* S.

### 2.3 Sound effects (SFX v2)

14. **SFX cue blocks** — "whoosh on cut", "ding on reveal" as `sfx` blocks on the timeline/flow. *Effort:* M.
15. **Ambience generator** — room tone / setting ambience for B-roll planning. *Effort:* S.
16. **Transition pack** — generate a set of transition sounds matched to edit style. *Effort:* S.

### 2.4 Transcription & analysis (Scribe v2)

17. **Reference-video transcription** — `analyze_video` transcribes spoken content, not just metadata
    → richer style profiling. *Effort:* M. *Notes:* high leverage, low risk; strong first pick.
18. **Channel-wide transcript mining** — `analyze_channel` runs Scribe across top videos to extract
    recurring phrases, hooks, structure. *Effort:* M–L.
19. **Speaker diarization** — separate host vs. guest in podcasts/interviews via `use_speaker_library`.
    *Effort:* M.
20. **Searchable transcript artifacts** — transcripts as canvas blocks the agent can quote/cite. *Effort:* M.
21. **Hook/structure extraction** — mine transcripts for "what makes this creator's intros work". *Effort:* M.

### 2.5 Voice agent — "Rainey" (Conversational AI 2.0)

22. **Spoken co-pilot in Creator Room** — talk to Rainey; it drives MCP tools by voice. *Lands:* mascot rig.
    *Effort:* L. *Notes:* flashiest; depends on real-time audio in the shell.
23. **Voice-driven brainstorming** — hands-free idea capture → `memory` / artifacts. *Effort:* L.
24. **Guided preproduction interview** — agent walks creator through goal/audience/format Q&A by voice,
    populating `memory`. *Effort:* L.
25. **Lip-sync / idle reactions** — map agent speech to mascot idle animations. *Effort:* M (on top of #22).

### 2.6 Dubbing

26. **Localization preview** — dub a draft VO into target languages to scope a localization plan. *Effort:* M.
27. **Reference-content translation** — understand non-English reference creators via dubbed transcripts.
    *Effort:* M.

### 2.7 Cross-cutting / platform

28. **Unified audio asset model** — one artifact pattern for vo/music/sfx blocks (consistent player,
    storage, versioning). *Effort:* M. *Notes:* foundational — do before scaling 2.1–2.3.
29. **Style-profile → ElevenLabs config map** — single mapping from creator profile to voice ID,
    music vibe, language, emotion defaults; stored in `memory`. *Effort:* M.
30. **Cost/usage guardrails** — track generation spend per project (audio gen is metered). *Effort:* S.
31. **Pronunciation dictionary** — per-project name/term pronunciations applied to all TTS. *Effort:* S.

---

## 3. Data-model implications (sketch)

Artifacts are frames; blocks live in `payload.elements[]` with a `type`. New block types to consider:

```jsonc
// element examples (inside artifacts.payload.elements[])
{ "id": "...", "type": "vo",       "text": "[whisper] welcome back", "voiceId": "...", "audioUrl": "...", "durationMs": 4200 }
{ "id": "...", "type": "music",    "prompt": "warm lo-fi intro",     "modelId": "music_v2", "audioUrl": "..." }
{ "id": "...", "type": "sfx",      "prompt": "soft whoosh",          "audioUrl": "..." }
{ "id": "...", "type": "dialogue", "lines": [ { "speaker": "A", "voiceId": "...", "text": "..." } ] }
{ "id": "...", "type": "transcript", "source": "video:...", "segments": [ { "speaker": "host", "t": 0.0, "text": "..." } ] }
```

Open questions to resolve before building:
- **Audio storage**: where do generated files live? (object store + URL in payload, vs. blob.)
- **Generation = sync or async?** Long music/dub calls likely need the websocket change-signal pattern.
- **Caching/idempotency**: re-render only on script/version change.
- **Voice ID lifecycle**: where chosen voices persist and how the canvas displays them.

---

## 4. Suggested sequencing (when we commit)

Not a decision — a default ordering by leverage ÷ effort:

1. **#17 Reference-video transcription** (Scribe) — improves the analysis we already do; low risk.
2. **#28 Unified audio asset model** — the substrate for everything in 2.1–2.3.
3. **#1 Script-block "hear it" preview** (v3) — most creator-facing payoff.
4. **#9 Music-bed** + **#14 SFX cue** — round out the audio artifact set.
5. **#22 Voice agent Rainey** — highest ceiling, highest cost; do last.

---

## 5. Sources

- [ElevenLabs Changelog](https://elevenlabs.io/docs/changelog) — freshest shipped capabilities
- [Models overview](https://elevenlabs.io/docs/overview/models) — model selection + pricing
- [Eleven v3](https://elevenlabs.io/v3) — audio-tag syntax
- [Eleven v3 launch blog](https://elevenlabs.io/blog/eleven-v3)
- [ElevenCreative Studio](https://elevenlabs.io/docs/eleven-creative/products/studio)
- [Docs home](https://elevenlabs.io/docs/overview/intro)
