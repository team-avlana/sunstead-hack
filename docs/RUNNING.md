# Running Rainy end-to-end (canvas + MCP + Postgres + Azure)

How to bring up the whole loop locally and drive it from your own Claude client.
Built on the canonical architecture (`docs/architecture.md`): the agent is **your
Claude** over MCP-HTTP; the **python-service** hosts the MCP tools + a read API +
a websocket; the **canvas-ui** renders the artifacts; **Aiven Postgres** is the
single source of truth; **Azure AI Foundry → Anthropic** does the analysis.

```
 Your Claude ──MCP/HTTP──► python-service ──spawns──► analysis-worker ──► Azure(Claude)
   (.mcp.json)              :9000  │  ▲ pg LISTEN/NOTIFY        │ writes
                            /api   │  └───────── ws change-signal ─────┐ │
                            /ws    ▼                                   ▼ ▼
                        canvas-ui  ◄── reads /api, re-pulls on ws ──  Aiven Postgres
                        :3000 (Next.js + tldraw, static-export-ready)
```

## 0. Prerequisites
- Python 3.11+ and Node 20+.
- Credentials in **`src/python-service/.env`** (gitignored — see `.env.example`):
  ```
  DB_CONNECTION_STRING=postgres://…aivencloud.com:20891/defaultdb?sslmode=require
  AZURE_ANTHROPIC_URL=https://<resource>.services.ai.azure.com/anthropic
  AZURE_ANTHROPIC_KEY=…
  ```
  `config.py` auto-loads this file, so no manual exports are needed.

## 1. python-service (MCP + read API + websocket)
```bash
cd src/python-service
python -m venv .venv && ./.venv/bin/pip install -r requirements.txt
./.venv/bin/python server.py            # → http://127.0.0.1:9000
```
Smoke test: `curl http://127.0.0.1:9000/api/health` → `{"ok":true,"db":true}`.

The DB schema is already applied to Aiven. To (re)apply on a fresh database:
`./.venv/bin/python ../database/apply_schema.py` (add `--reset` to drop first).

## 2. canvas-ui (the infinite canvas)
```bash
cd src/canvas-ui
echo 'NEXT_PUBLIC_RAINY_API_URL=http://localhost:9000' > .env.local   # gitignored
npm install
npm run dev                              # → http://localhost:3000
```
With the API URL set, the Home grid lists Postgres-backed projects and the canvas
reads artifacts from `/api`, subscribing to `/ws` for live updates. **Unset it**
and the canvas runs fully offline on the bundled XML seeds (including the
`Video Block — States & Disclosure` showcase).

## 3. Connect your Claude (MCP)
`.mcp.json` (repo root) already registers the server:
```json
{ "mcpServers": { "local-python-service": { "type": "http", "url": "http://127.0.0.1:9000/mcp" } } }
```
Start Claude Code in this repo (with the python-service running) and approve the
server. You then have 16 tools (`mcp__local-python-service__*`): `create_project`,
`create_artifact`, `analyze_video`, `analyze_channel`, `get_video_analysis`,
`save_memory`, … Try:

> "Create a project called *My Channel*, then add a video block for
> https://youtu.be/… and analyse it."

The agent calls `create_project` → `create_artifact` (a `type:'video'` block) →
`analyze_video`. The canvas shows the block flip **empty → analysing → analysed**
in real time as the worker writes results and NOTIFYs the canvas.

## 4. Seed the demo (optional)
```bash
cd src/database
../python-service/.venv/bin/python seed_demo.py
```
Drives the MCP tools over HTTP to create a **"Rainy — Video Block Demo"** project
whose blocks reference real analysed/analysing/failed videos already in Aiven.
Open the printed `#/p/<id>` in the canvas.

## The Video Block
The fundamental video interface. It renders the analysis lifecycle and
progressively discloses fields by stage, across three compactness levels you
toggle with the chevron + storyboard control:

| Stage (`*`) | Disclosed | Source |
|---|---|---|
| `*`  not analysed → | title, thumbnail, tags | `videos.title`, palette gradient, derived from `metrics.llm` |
| `**` analysed →     | transcript, description | `metrics.transcript.text`, `metrics.llm.overall_style_summary` |
| `***` analysed →    | storyboard scenes | `metrics.llm.segments[]` joined to `shots[]` |

States: **empty · not_analysed · analysing · analysed · error**.

![Live Video Blocks from Postgres](demo/video-blocks-live.png)
![All states & disclosure levels](demo/video-blocks-states.png)

## How it fits together
- **Video blocks are artifacts** of `type:'video'` whose `payload.video_id` points
  at a `videos` row. The read API joins the live analysis (`video_view.derive_video`)
  so the canvas stays dumb. Placeholder blocks (empty / not_analysed) carry their
  `state` in the payload instead of a `video_id`.
- **Realtime** is a websocket change-signal only — never data. `analyze_video` and
  the analysis-worker emit a Postgres `NOTIFY rainy_change`; the service forwards it
  to the right project's subscribers; the canvas re-pulls and reconciles. A
  visibility-aware 6s poll covers any missed signal.
- **No DDL** was added to the shared DB — only `pg_notify` (a function call).
