# Rainy

**Rainy is an AI creator companion for video preproduction.** Paste your YouTube or Tiktok channel — Rainy downloads and analyses your past videos (shot detection, transcription, visual style profiling), understands your editing style and then your own Claude client drives an infinite canvas where you research, ideate, script, storyboard, and plan shot lists. The canvas and the AI are co-equal writers: Claude creates and populates artifacts, you edit them directly.

> Landing page: [rainey.lovable.app](https://rainey.lovable.app/)

The agent is the user's own **Claude client (Claude Code / Claude Desktop)** connecting over MCP-HTTP. Postgres (Aiven) is the single source of truth; all components connect to it directly.

> **Canonical architecture:** [`docs/architecture.md`](docs/architecture.md)
> **Canonical data model:** [`src/database/schema.sql`](src/database/schema.sql)
> **How to run (full guide):** [`docs/RUNNING.md`](docs/RUNNING.md)
> **Decision log:** [`docs/DECISIONS.md`](docs/DECISIONS.md)

## External services

| Service | Used for | Why |
|---------|----------|-----|
| **Claude** (Anthropic) | Visual scene interpretation; creator style aggregation across videos | Best-in-class vision reasoning; runs as the user's own agent over MCP so no key management on our side |
| **ElevenLabs** | High-quality cloud transcription of reference videos | Outperforms local speech models for accented / fast-paced creator content |
| **OpenAI** (`gpt-image-1`) | Generating creator room images and storyboard frames | Currently the strongest model for the cozy clay-render aesthetic Rainy uses |
| **Aiven** | Hosted Postgres database | Managed open-source infra — full control, no vendor lock-in, self-hostable if needed |

## Components (`src/<component>/`)

| Component | Tech | Role |
|-----------|------|------|
| `python-service` | Python · FastMCP on uvicorn · HTTP :9000 | MCP server (16 tools); REST read/write API; WebSocket change-signal hub; image generation; spawns the analysis worker |
| `analysis-worker` | Python | `yt-dlp` → PySceneDetect → ffmpeg → Claude vision → style profile; writes results to Postgres |
| `canvas-ui` | Next.js (App Router) + tldraw v5 | Infinite canvas; renders and edits artifacts; re-pulls from Postgres on WebSocket ping; bidirectional sync |
| `mac-app` | Swift / SwiftUI + WKWebView | Native shell for `canvas-ui` — placeholder only, not yet built |
| Database | Postgres (Aiven) | Single source of truth; all components connect directly |

## Repository layout

```
docs/
  architecture.md          ← canonical architecture
  RUNNING.md               ← how to run the full stack locally
  INTEGRATION_NOTES.md     ← reconciliation log (planning vs. built)
  DECISIONS.md             ← full decision log (D1…D38+)
  FEASIBILITY.md           ← feasibility analysis
  BACKEND_INTEGRATION.md   ← ⚠️ superseded (pre-pivot stdio/SQLite contract)
  NEXT_STEPS.md            ← ⚠️ superseded (pre-pivot SwiftUI-first plan)
knowledge-base/            dated reference docs — read before building
src/
  python-service/          MCP server + REST API + WebSocket hub + image gen
  analysis-worker/         video download & analysis pipeline
  database/schema.sql      Postgres schema — canonical data model
  canvas-ui/               Next.js + tldraw infinite canvas
  mac-app/                 SwiftUI + WKWebView shell (placeholder)
mcp-server/                ⚠️ superseded early stdio/SQLite stub
```

## How to run

See **[`docs/RUNNING.md`](docs/RUNNING.md)** for the complete step-by-step guide, including how to seed the demo, drive it from Claude, and what the Video Block does.

### Secrets

Create `src/python-service/.env` — all values read from env at startup (overrides `config.toml`):

```
# Required
DB_CONNECTION_STRING=postgres://…aivencloud.com:20891/defaultdb?sslmode=require

# Claude vision (for video analysis) — use Azure AI Foundry or direct Anthropic key
AZURE_ANTHROPIC_URL=https://<resource>.services.ai.azure.com/anthropic
AZURE_ANTHROPIC_KEY=…
# ANTHROPIC_API_KEY=…   # alternative: direct Anthropic key

# Image generation (for Creator Room / storyboard frames)
AZURE_OPENAI_URL=https://<resource>.openai.azure.com
AZURE_OPENAI_KEY=…

# Optional
ELEVENLABS_API_KEY=…    # voice features
```

### python-service

```bash
cd src/python-service
python -m venv .venv
./.venv/bin/pip install -r requirements.txt
./.venv/bin/pip install -r ../analysis-worker/requirements.txt   # worker runs in same venv
# ffmpeg must be on PATH for the worker
PATH="$PWD/.venv/bin:$(brew --prefix)/bin:$PATH" ./.venv/bin/python server.py
```

Smoke test: `curl http://127.0.0.1:9000/api/health` → `{"ok":true,"db":true}`

### canvas-ui

```bash
cd src/canvas-ui
echo 'NEXT_PUBLIC_RAINY_API_URL=http://localhost:9000' > .env.local
npm install && npm run dev   # → http://localhost:3000
```

Unset `NEXT_PUBLIC_RAINY_API_URL` to run fully offline on the bundled seed data.

### Connect Claude (MCP)

`.mcp.json` at the repo root already registers the MCP server. Start Claude Code in this repo with the python-service running — you'll have 16 tools (`create_project`, `analyze_video`, `create_artifact`, `analyze_channel`, `get_style_profile`, `save_memory`, …).
