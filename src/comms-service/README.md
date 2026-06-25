# Rainy Comms Service

The canonical server-side service (see `CLAUDE.md` and `docs/architecture.md`).
The canvas-ui ships as a **static export** with no Node/Next server, so anything
the client can't do itself — Postgres reads, real-time pings, live generation —
lives here over HTTP.

**First feature:** generate the **Creator Room** — a personalized clay-render of a
creator's world. Two modes:
- **Image (default):** profile → image prompt → **OpenAI `gpt-image-1`** → a clay
  diorama PNG. Anthropic can't output images, so the *paint* step uses gpt-image-1
  (Claude optionally refines the prompt when `ANTHROPIC_API_KEY` is set).
- **3D (alternative):** Claude (Opus 4.8) writes a self-contained three.js document
  the UI renders in a sandboxed `<iframe>`.

When a key/service is missing, the UI falls back (sample image / built-in
procedural 3D room) — so the canvas always works.

## Run (dev)

```bash
cd src/python-service
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # add OPENAI_API_KEY (image mode); ANTHROPIC_API_KEY (3D mode)
uvicorn app:app --reload --port 8787    # app.py auto-loads .env
```

Point the canvas-ui at it:

```bash
# src/canvas-ui/.env.local
NEXT_PUBLIC_COMMS_API_URL=http://localhost:8787/api
```

## Endpoints

| Method | Path | Body | Returns |
|---|---|---|---|
| GET  | `/api/health` | — | `{ ok, model, imageModel, generation, image }` (`*`=key present) |
| POST | `/api/creator-room/image` | `{ "profile": { … } }` | `{ image (data URL), prompt, model }` — **default mode** |
| POST | `/api/creator-room/generate` | `{ "profile": { … } }` | `{ html, model }` — 3D mode |

`profile` is the `CreatorProfile` shape from `src/canvas-ui/lib/creatorRoom.ts`
(creator / library / content / referral / style / companions).

### Errors
- **503** — generation unavailable (no `ANTHROPIC_API_KEY`, SDK missing, or the
  model declined). The UI treats this as "fall back to the procedural room".
- **500** — unexpected failure.

## Model

`claude-opus-4-8`, adaptive thinking, streamed (large `max_tokens` would otherwise
risk an HTTP timeout). See `creator_room.py` for the system prompt and the
fixed-skeleton + variable-payload design contract.

## Notes
- CORS is permissive (`*`) by default for local dev; set `RAINY_ALLOWED_ORIGINS`
  to the real origins (`http://localhost:3000`, `app-resource://app`) in prod.
- This is the start of the Comms Service, not its final shape — realtime pings
  (SSE) and Postgres reads land here next (see the architecture docs).
