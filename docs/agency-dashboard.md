# Agency UGC Dashboard

> Branch: `feat/ugc-agency-dashboard`. The operational surface for the agency
> coaching job — a roster, a deliveries queue, and a copy-paste coaching note.
> NOT the canvas. See `docs/ugc-coaching-exploration.md` for the why and
> `docs/DECISIONS.md` D43–D46 for the locked-in choices.

## What it is

A thin web dashboard that fronts the existing analysis core. Three views, hash-routed
inside a single static route at `/agency`:

- **Roster** (`#/`) — every creator you coach, with hook · tone · pacing · reference
  scores trending (sparklines), delivery counts, latest verdict, "new" badges for
  deliveries waiting to review. Sorted so triage floats to the top.
- **Creator** (`#/c/<creator_id>`) — improvement-over-time chart (the retention hook),
  at-a-glance stats (latest overall, reviewed count, approval rate), and the creator's
  deliveries queue.
- **Delivery / review** (`#/r/<review_id>`) — verdict + overall score donut, a
  per-dimension scorecard with concrete comments, strengths / missing-from-brief, the
  delivery (and reference) media, and the **Slack-ready coaching note** with a Copy
  button. Polls live while the delivery is analysing.

## The loop

```
New review (modal)
  pick/﹢creator · upload file OR paste URL · brief (optional) · reference URL (optional)
        │
        ▼
POST /api/agency/deliveries
  → create delivery video (upload saved locally, or URL) → spawn analysis worker
  → optional reference video → spawn worker
  → create review row (status=analyzing)
  → spawn watcher thread
        │  (watcher waits for analysis, then…)
        ▼
review_generate.generate_review(review_id)
  → gather delivery + reference + brief (same signals as compare_components)
  → Claude (forced tool-use) → verdict, per-dimension scores, strengths, missing, note
  → persist on the review row (status=ready); scores feed the trend
        │
        ▼
Dashboard polls GET /api/agency/reviews/<id> → renders the scorecard + note
```

The review reasoning is identical to the canvas agent's (D40) — it just runs as one
headless server call so a button-driven surface needs no chat agent.

## Run it

1. **Apply the migration** (local Postgres, per D41 — Aiven untouched):
   ```bash
   psql "$DB_CONNECTION_STRING" -f src/database/migrations/003_agency_reviews.sql
   ```
   (A fresh DB from `src/database/schema.sql` already has it.)

2. **Start the python-service** (needs `DB_CONNECTION_STRING` and Anthropic creds —
   `ANTHROPIC_API_KEY`, or `AZURE_ANTHROPIC_URL` + `AZURE_ANTHROPIC_KEY` for Foundry;
   `ffmpeg`/`ffprobe`/`yt-dlp` on PATH for analysis):
   ```bash
   cd src/python-service && .venv/bin/python server.py   # binds 127.0.0.1:9000
   ```

3. **Start the canvas-ui** with the backend URL set:
   ```bash
   cd src/canvas-ui
   echo 'NEXT_PUBLIC_RAINY_API_URL=http://localhost:9000' >> .env.local
   npm run dev
   ```

4. Open **http://localhost:3000/agency** → New review → upload a short clip + paste a
   brief → watch it analyse and the coaching note appear.

## API (python-service)

```
GET    /api/agency/roster                  -> {roster:[...]}            roster table
POST   /api/agency/creators                -> add a talent creator
GET    /api/agency/creators/{id}           -> {creator, reviews:[...]}  creator + queue
POST   /api/agency/deliveries              -> ingest (upload or URL) + start review
GET    /api/agency/reviews/{id}            -> {review, delivery, reference, creator}
POST   /api/agency/reviews/{id}/run        -> (re)generate the review
DELETE /api/agency/reviews/{id}            -> soft-delete
```

## Files

- Backend: `src/python-service/agency_routes.py`, `review_generate.py`, `db.py`
  (agency section), `src/database/{schema.sql, migrations/003_agency_reviews.sql}`,
  `src/analysis-worker/{main.py, download.py}` (upload:// path).
- Frontend: `src/canvas-ui/app/agency/page.tsx`, `src/canvas-ui/lib/agency.ts`,
  `src/canvas-ui/components/agency/*`.

## Known limits / next

- **Ingestion**: upload is reliable; URL is best-effort (D42 — TikTok/IG may need
  cookies). Reference videos are URL-only.
- **Scoring honesty**: scores are agent-reasoned per delivery; the rubric is fixed in
  `review_generate._REVIEW_SCHEMA` so trends are comparable, but it isn't a deterministic
  contract yet (open question §11.4 in the exploration doc).
- **No Slack delivery** yet — the note is copy-paste. Slack-out and a creator-facing
  self-check portal are the Phase-2/3 surfaces.
- **Auth**: none — local-only, same posture as the rest of the service.
