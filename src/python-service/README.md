# python-service

Long-running ASGI process that hosts the MCP server (over streamable HTTP) and
notifies the canvas-ui over WebSocket whenever an artifact changes.

## Quick start

```bash
cd src/python-service
pip install -r requirements.txt
python server.py
```

Or via uvicorn directly:

```bash
uvicorn server:app --host 127.0.0.1 --port 9000
```

## Configuration

Copy the example below to `config.toml` in the same directory (or set
`APP_CONFIG=/path/to/config.toml`):

```toml
[server]
host = "127.0.0.1"
port = 9000

[worker]
python = "python"
entrypoint = "../analysis-worker/main.py"
max_channel_videos = 5
```

Credentials come from environment variables (typically via a `.env` file in the
project root — see below). They can also be set in `config.toml` under `[llm]`
and `[db]` as a fallback, but env vars take precedence:

| Env var | Purpose |
|---------|---------|
| `DB_CONNECTION_STRING` | Postgres DSN |
| `AZURE_ANTHROPIC_URL` | Azure AI Foundry endpoint (passed to the analysis-worker) |
| `AZURE_ANTHROPIC_KEY` | Azure AI Foundry API key (passed to the analysis-worker) |

## Endpoints

| Endpoint | Protocol | Purpose |
|----------|----------|---------|
| `/mcp`   | HTTP (streamable) | MCP tools for the Claude agent |
| `/ws`    | WebSocket | Change signals for the canvas-ui |

WebSocket accepts an optional `?project_id=<uuid>` query param to scope
notifications to a single project.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `APP_CONFIG` | `./config.toml` | Path to the TOML config file |

## MCP tools

**Projects:** `create_project`, `list_projects`

**Analysis:** `analyze_video`, `analyze_channel`, `get_video_analysis`, `get_channel_analysis`

**Artifacts:** `create_artifact`, `update_artifact`, `get_artifact`, `list_artifacts`, `delete_artifact`

**Memory:** `save_memory`, `list_memory`, `delete_memory`

**Creators:** `list_creators`, `get_style_profile`
