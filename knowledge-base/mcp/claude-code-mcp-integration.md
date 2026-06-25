# Claude Code ↔ MCP Integration Reference
_Last updated: 2026-06-24_

How Claude Code (the CLI) discovers, registers, connects to, and uses MCP servers — with a focus on a **local stdio MCP server** (the Rainy case: a Python FastMCP server spoken over stdin/stdout). Authoritative source is the official Claude Code docs (`code.claude.com/docs/en/mcp`, `.../permissions`). Items that are version-gated or otherwise uncertain are flagged inline.

---

## 1. Mental model

- An MCP server exposes **tools**, **resources**, and **prompts**. Claude Code is the MCP **client**.
- Claude Code learns about servers from **config** (CLI-written or hand-edited JSON). It then **spawns** (stdio) or **connects to** (HTTP/SSE/WS) each server, performs the MCP handshake, and surfaces the server's capabilities into the session.
- For a desktop app like Rainy that bundles a local server, the relevant transport is **stdio**: Claude Code launches your server as a child process and talks to it over stdin/stdout. No port, no URL, no OAuth.

---

## 2. Registering a server: `claude mcp add`

General form:

```bash
# stdio (local process) — note the `--` separator
claude mcp add [options] <name> -- <command> [args...]

# remote HTTP / SSE
claude mcp add --transport http <name> <url>
claude mcp add --transport sse  <name> <url>
```

### The `--` separator (stdio only) — easy to get wrong
For stdio servers, `--` divides **Claude's own flags** (`--transport`, `--env`, `--scope`) from **the command that runs the server**. Everything after `--` is passed to the server untouched.

```bash
claude mcp add --transport stdio myserver -- npx server          # runs: npx server
claude mcp add --env KEY=value --transport stdio myserver -- python server.py --port 8080
#   runs: python server.py --port 8080   with KEY=value in env
```
Without `--`, Claude Code tries to parse the server's own flags (e.g. `--port`) as its own options and fails.

### Flags
| Flag | Purpose |
|---|---|
| `--transport stdio\|http\|sse` | Transport. `stdio` is the default for the `--` form. |
| `--scope local\|project\|user` | Where the config is written (see §4). Default `local`. |
| `--env KEY=value` | Env var for the spawned server. Repeatable. **Gotcha:** don't put the server `<name>` directly after `--env` — the CLI reads it as another `KEY=value` pair and rejects it. Put at least one other flag between them. |
| `--header "K: V"` | (HTTP/SSE only) static request header, e.g. Bearer token. |
| `--client-id`, `--client-secret`, `--callback-port` | (HTTP/SSE only) pre-configured OAuth. No effect on stdio. |

### Other CLI subcommands
```bash
claude mcp list                 # list servers + status
claude mcp get <name>           # details for one server (shows OAuth state, pending/rejected)
claude mcp remove <name>
claude mcp add-json <name> '<json>'        # add from a raw JSON blob
claude mcp add-from-claude-desktop         # import (macOS / WSL only)
claude mcp reset-project-choices           # reset approval of project-scoped .mcp.json servers
claude mcp serve                # run Claude Code ITSELF as a stdio MCP server
# v2.1.186+: OAuth from the shell
claude mcp login <name>         # (HTTP/SSE) run OAuth flow; --no-browser for SSH
claude mcp logout <name>
```

---

## 3. The JSON config format

All scopes share the same `mcpServers` object shape. A **stdio** entry uses `command` / `args` / `env`; a **remote** entry uses `url` / `headers`.

### stdio (the Rainy case)
```json
{
  "mcpServers": {
    "rainy": {
      "type": "stdio",
      "command": "/Applications/Rainy.app/Contents/Resources/venv/bin/python",
      "args": ["/Applications/Rainy.app/Contents/Resources/server.py"],
      "env": {
        "RAINY_DB": "${HOME}/Library/Application Support/Rainy/rainy.db"
      }
    }
  }
}
```
- `type` is `"stdio"` (may be omitted for the `command` form, but be explicit).
- `command` should be an **absolute path** to the interpreter/binary, or something guaranteed on PATH. For a bundled app, point at the app's embedded interpreter so you don't depend on the user's system Python.
- `args` is an array (each token separate — don't pack a whole command line into one string).
- `env` is an object of string→string.

### remote (for completeness)
```json
{
  "mcpServers": {
    "weather-api": {
      "type": "http",
      "url": "${API_BASE_URL:-https://api.example.com}/mcp",
      "headers": { "Authorization": "Bearer ${API_KEY}" }
    }
  }
}
```
- `type: "http"` (canonical) — `"streamable-http"` is accepted as an **alias** (the MCP spec's name for this transport), so configs copied from server docs work unmodified.
- `type: "sse"` — **deprecated**; prefer `http`. If `--transport sse` gives connection errors, switch to `http` (most servers expose streamable HTTP on the same URL).
- `type: "ws"` (WebSocket) — only configurable via `.mcp.json` / `add-json`, header auth only, no `--transport ws` flag.

### Environment-variable expansion (in `.mcp.json` and config files)
- `${VAR}` → value of `VAR`; `${VAR:-default}` → `VAR` or `default`.
- Expanded in: `command`, `args`, `env`, `url`, `headers`.
- If a referenced var is unset **and has no default**, Claude Code **fails to parse the whole config**. Use `:-default` for anything machine-specific.

### Useful per-server fields (beyond command/url)
| Field | Effect |
|---|---|
| `"timeout": <ms>` | Hard wall-clock limit per tool call for this server. Overrides `MCP_TOOL_TIMEOUT`. Values < 1000 are ignored. |
| `"alwaysLoad": true` | Exempt this server from MCP Tool Search deferral — all its tools load into context at session start (and startup blocks up to the 5s connect cap). _Requires Claude Code v2.1.121+._ |
| `"headersHelper": "<cmd>"` | (HTTP/SSE/WS) generate auth headers at connect time via a shell command (10s timeout). Runs only after workspace-trust acceptance at project/local scope. |
| `"oauth": { ... }` | (HTTP/SSE) `clientId`, `callbackPort`, `scopes`, `authServerMetadataUrl`. Not relevant to stdio. |

---

## 4. Scopes: local / project / user

| Scope | Loads in | Shared with team | Stored in |
|---|---|---|---|
| **local** (default) | Current project only | No | `~/.claude.json` (keyed under the project path) |
| **project** | Current project only | Yes (commit to git) | `.mcp.json` at project root |
| **user** | All your projects | No | `~/.claude.json` |

Notes:
- **local** is the default; an older naming called it `project`, and the old `global` is now `user`.
- MCP "local scope" ≠ general local settings: MCP local servers live in `~/.claude.json`, whereas `.claude/settings.local.json` is for general settings — different files.
- **Precedence** when the same server name appears in several places (Claude connects once, uses the highest, no field merging): **local → project → user → plugin-provided → claude.ai connectors.** The three named scopes match by **name**; plugins/connectors match by **endpoint** (URL or command).

For a desktop app installing a personal, machine-wide server, **`--scope user`** is usually the right choice (available in every project, private to the user, no git involvement).

---

## 5. Verifying the server is connected (`/mcp`)

- Inside a Claude Code session, run **`/mcp`**. The panel lists each server, its connection state, and the **tool count** next to it. It flags servers that advertise the tools capability but expose zero tools.
- From the shell, `claude mcp list` / `claude mcp get <name>` show status. A **project-scoped** server awaiting approval shows as `⏸ Pending approval`; rejected shows `✗ Rejected`.
- `/mcp` is also where you complete **OAuth** for remote servers and "Clear authentication".

### Connection behavior / startup
- MCP startup is **non-blocking by default**: servers connect in the background. If a request needs a still-connecting server's tools, Claude waits (inside the `ToolSearch` call when Tool Search is on — the default — or via a `WaitForMcpServers` tool when it's off).
- **Reconnection:** HTTP/SSE servers auto-reconnect with exponential backoff (up to 5 attempts, 1s→doubling); shown as pending in `/mcp`, then "failed" with a manual retry. **Stdio servers are local processes and are NOT auto-reconnected** — if your server dies, the session won't respawn it. _(Flag: design Rainy's server to be robust/long-lived, or expect the user to restart the session.)_ As of **v2.1.121**, initial HTTP/SSE connections also retry up to 3× on transient errors.
- `MCP_TIMEOUT` env var sets the server **startup** timeout (e.g. `MCP_TIMEOUT=10000 claude` = 10s).
- **Dynamic updates:** Claude Code honors MCP `list_changed` notifications — your server can change its tools/prompts/resources mid-session and they refresh automatically.
- The server name **`workspace`** is reserved — a server with that name is skipped with a warning. Don't name yours `workspace`.

---

## 6. How tools / resources / prompts appear and are invoked

### Tools — canonical name `mcp__<server>__<tool>`
- A tool `roll` from server `rainy` is callable/identified as **`mcp__rainy__roll`**.
- Plugin-bundled servers use the longer form **`mcp__plugin_<plugin>_<server>__<tool>`** (non-`[A-Za-z0-9_-]` chars → `_`).
- Claude selects tools automatically; you don't type tool names. The canonical name matters for **permission rules**, a skill's `allowed-tools`, or a subagent's `tools` field.

### Resources — `@` mentions
- Type `@` in a prompt to autocomplete resources from connected servers (alongside files).
- Reference format: **`@server:protocol://resource/path`**, e.g. `@github:issue://123`, `@docs:file://api/authentication`. Multiple per prompt allowed. Referenced resources are fetched and attached automatically. Claude Code auto-provides list/read tools when the server supports resources.

### Prompts — slash commands
- Server prompts appear as **`/mcp__<server>__<prompt>`** in the `/` menu.
- Args are space-separated after the command: `/mcp__github__pr_review 456`, `/mcp__jira__create_issue "Bug in login flow" high`. Results are injected into the conversation. Names are normalized (spaces → underscores).

### Elicitation (server → user input)
- Servers can request structured input mid-task; Claude Code shows a form or opens a browser URL automatically. No config needed. Can be auto-answered via the `Elicitation` hook.

---

## 7. Permissions / approval of MCP tools

Permission rules live in `settings.json` (`permissions.allow` / `ask` / `deny`). Evaluation order is **deny → ask → allow** (first match wins; deny from any scope beats allow from any scope).

MCP rule syntax:
| Rule | Effect |
|---|---|
| `mcp__rainy` | Matches **any** tool from the `rainy` server. |
| `mcp__rainy__*` | Same — all tools from `rainy` (explicit wildcard). |
| `mcp__rainy__roll` | Matches just the `roll` tool. |
| `mcp__*` | (deny/ask only) every MCP tool across all servers. |

```json
{
  "permissions": {
    "allow": ["mcp__rainy__*"],
    "deny":  ["mcp__rainy__delete_everything"]
  }
}
```

Important constraints:
- **Allow** rules accept a tool-name glob **only after a literal `mcp__<server>__` prefix**, and the `<server>` segment must be glob-free (names a specific configured server). An unanchored allow glob like `"*"` or `"mcp__*"` is **skipped with a warning** and auto-approves nothing.
- **Deny / ask** rules additionally accept tool-name globs in the name position (`"mcp__*"`, `"*"`).
- Without an allow rule, MCP tool calls follow the standard tiered prompt — Claude asks before first use. There is no built-in "yes, don't ask again" persistence specifically documented for MCP the way Bash has; pre-approve via `permissions.allow` or `/permissions`.
- **Project-scoped servers** (`.mcp.json`) get an extra gate: Claude Code prompts to **approve the server itself** before any of its tools are usable (security against a malicious committed `.mcp.json`). Reset with `claude mcp reset-project-choices`.
- PreToolUse hooks can also gate MCP calls (cannot loosen a deny rule).
- Settings precedence (tightest first): managed → CLI args → `.claude/settings.local.json` → `.claude/settings.json` → `~/.claude/settings.json`. A deny at any level wins.

---

## 8. Output limits, timeouts, Tool Search (gotchas)

- **Output:** warning at **10,000 tokens** of tool output; default hard cap **25,000 tokens**, raise via `MAX_MCP_OUTPUT_TOKENS`. A server can raise a single tool's text limit via `_meta["anthropic/maxResultSizeChars"]` (ceiling 500,000 chars); image output is always bound by the token limit. Over-cap text results are persisted to disk and replaced with a file reference.
- **Per-tool-call timeout:** `"timeout"` (ms) per server entry, or `MCP_TOOL_TIMEOUT` globally. For remote servers there's also an **idle timeout** — _v2.1.187+_: an HTTP/SSE/WS/connector tool call with no response/progress for 5 min aborts (tune via `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` ms, `0` to disable). **Stdio servers are exempt from the idle timeout.**
- **MCP Tool Search (default on):** only tool *names* + server instructions load at session start; full schemas load on demand. So adding many servers barely costs context. Server *instructions* (≤2KB, truncated) tell Claude when to search for your tools — write good ones. To force a server's tools to always load, set `"alwaysLoad": true`. Disabled automatically on Vertex AI and when `ANTHROPIC_BASE_URL` is a non-first-party host; control via `ENABLE_TOOL_SEARCH` (`true`/`false`/`auto`/`auto:N`). Requires a model supporting `tool_reference` blocks (Haiku does not). _(Flag: behavior differs across hosts/models.)_
- `CLAUDE_PROJECT_DIR` is set in the **spawned stdio server's** environment (the project root). Read it in-process (`os.environ["CLAUDE_PROJECT_DIR"]` in Python). Because it's set in the server env (not Claude Code's), referencing it via `${CLAUDE_PROJECT_DIR}` inside `.mcp.json` `command`/`args` needs a default (`${CLAUDE_PROJECT_DIR:-.}`) unless the config is plugin-provided. Your server can also call MCP `roots/list` to get the launch directory.

---

## 9. Connecting a bundled FastMCP (Python) stdio server

FastMCP (the Python framework) ships a CLI helper specifically for Claude Code.

### Easiest: `fastmcp install claude-code`
```bash
fastmcp install claude-code server.py
fastmcp install claude-code server.py:mcp            # explicit server object
fastmcp install claude-code server.py --with pandas --with requests
fastmcp install claude-code server.py --with-requirements requirements.txt
fastmcp install claude-code server.py --python 3.11
fastmcp install claude-code server.py --env API_KEY=xxx --env DEBUG=true
fastmcp install claude-code server.py --env-file .env
```
This writes the Claude Code MCP config and manages deps for you. **Requirement:** the Claude Code CLI must be installed; the integration looks for it at the default location `~/.claude/local/claude`.

A `fastmcp.json` can declare source + deps declaratively:
```json
{
  "$schema": "https://gofastmcp.com/public/schemas/fastmcp.json/v1.json",
  "source": { "path": "server.py", "entrypoint": "mcp" },
  "environment": { "dependencies": ["pandas", "requests"] }
}
```

### Manual (native Claude Code command, more control)
```bash
# via uv, pulling fastmcp on the fly
claude mcp add rainy -- uv run --with fastmcp fastmcp run server.py

# with env + scope
claude mcp add rainy --scope user -e API_KEY=secret -- uv run --with fastmcp fastmcp run server.py
```
For a **bundled** desktop app you typically bypass `uv`/`fastmcp run` and point `command` straight at the app's embedded interpreter running your entry script (see the §3 stdio example) — that avoids depending on the user having `uv`/`fastmcp`/`python` on PATH.

---

## 10. How an app like Rainy registers its server (recommended UX)

You have three realistic paths; pick by how much you control the user's machine.

**A. Programmatically write to `~/.claude.json` (user scope) — most reliable, zero CLI dependency.**
- Read `~/.claude.json`, add/merge your entry under the top-level `mcpServers` key (user scope), write it back. Point `command` at the **bundled interpreter** (absolute path inside the `.app`), `args` at your entry script, and pass app paths via `env`.
- Pros: no dependency on `claude` being on PATH or installed at a particular location; survives across all the user's projects. Cons: you're editing a file Claude Code owns — merge carefully, don't clobber existing servers, and re-write on app update if your bundle paths change. _(Flag: `~/.claude.json` schema is Claude-Code-internal; key off `mcpServers` and the `projects` map as shown in §4, and tolerate unknown keys.)_

**B. Shell out to `claude mcp add ... --scope user`.**
- Cleaner/forward-compatible (Claude Code owns the write), but requires the `claude` binary to be found. Resolve it robustly (`which claude`, then fall back to `~/.claude/local/claude`). Quote the `--` form correctly and pass an absolute `command` path.

**C. Instruct the user to run one command (onboarding copy).**
- Show a copy-paste block in your onboarding flow, e.g.:
  ```bash
  claude mcp add rainy --scope user -- "/Applications/Rainy.app/Contents/Resources/venv/bin/python" "/Applications/Rainy.app/Contents/Resources/server.py"
  ```
- Or, if you ship a FastMCP server and assume `fastmcp`/`uv` present: `fastmcp install claude-code <path-to-server.py>`.

**Onboarding UX recommendations**
- Prefer **A or B at `--scope user`** so the server is available in every project without the user editing anything per-repo.
- After registering, tell the user to run **`/mcp`** in any Claude Code session to confirm `rainy` shows **connected** with a non-zero tool count (this is the single best "did it work?" check).
- Pre-seed permissions: write `permissions.allow: ["mcp__rainy__*"]` into the user's `~/.claude/settings.json` so the user isn't prompted on every tool call (only do this for tools you're confident are safe; keep destructive ones out of the allowlist or in `deny`).
- Give the server good **server instructions** (≤2KB) so Tool Search surfaces it at the right moments, and **stable tool names** (`mcp__rainy__*` is what permission rules and the user's allowlist key on — renaming tools breaks their rules).
- Because **stdio servers aren't auto-reconnected**, make the server resilient: long-lived, no crash-on-bad-input, idempotent startup. A crash means the user must restart the Claude Code session.
- Handle **app updates**: if your bundle path or interpreter version changes, re-write the config (path in `command`/`args` will otherwise point at a stale location).

---

## Sources
- Connect Claude Code to tools via MCP — https://code.claude.com/docs/en/mcp
- Configure permissions (Claude Code) — https://code.claude.com/docs/en/permissions
- Claude Code 🤝 FastMCP — https://gofastmcp.com/integrations/claude-code
- MCP specification (transports, capabilities) — https://modelcontextprotocol.io/introduction
- MCP server build guide — https://modelcontextprotocol.io/docs/develop/build-server
