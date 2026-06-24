# MCP Protocol Essentials

_Last updated: 2026-06-24_

Practical spec reference for someone building an MCP **server** (Rainy: Python + FastMCP
over stdio, driving a macOS app). Focus: what's on the wire, and what a server author
must implement vs. what FastMCP does for you.

## Protocol revision

- **Latest stable revision: `2025-11-25`.** Revisions are dated, not semver. The version
  string is exchanged during the handshake (`protocolVersion: "2025-11-25"`).
- Prior revisions still seen in the wild: `2025-06-18`, `2025-03-26`, `2024-11-05`
  (which used the now-deprecated HTTP+SSE transport).
- Authoritative schema: the TypeScript schema at
  `schema/2025-11-25/schema.ts` in the spec repo.
- ⚠️ A larger **2026-07-28** revision is in release-candidate / roadmap status (stateless
  HTTP core, a Tasks extension, MCP "Apps" server-rendered UIs, tighter OAuth alignment,
  a formal deprecation policy). **Not final as of 2026-06-24** — treat as beta and target
  `2025-11-25` for shipping. Note: `2025-11-25` already advertises `tasks` capabilities
  in the handshake (see below), so some of that work has begun landing.

## Architecture & roles

JSON-RPC 2.0 over a bidirectional transport. Three roles:

- **Host** — the LLM application (Claude Code, Claude Desktop).
- **Client** — a connector inside the host; one client per server connection.
- **Server** — provides context/capabilities. **This is Rainy's role.**

## Primitives

**Server → client** (what a server offers; Rainy implements these):

| Primitive   | Purpose                                                        |
|-------------|---------------------------------------------------------------|
| **Tools**   | Functions the model can call (may execute code / mutate state)|
| **Resources**| Readable context/data addressed by URI                       |
| **Prompts** | Templated message workflows the user can invoke               |

**Client → server** (capabilities the *client* offers; a server may use them, but only
if negotiated):

| Primitive      | Purpose                                                          |
|----------------|------------------------------------------------------------------|
| **Sampling**   | Server asks the client's LLM to generate text (recursive agents) |
| **Roots**      | Server queries the filesystem/URI boundaries it may operate in   |
| **Elicitation**| Server requests additional structured input from the user        |

Plus utilities: logging, progress, cancellation, completion (argument autocomplete),
ping, and (in `2025-11-25`) **tasks** for long-running / task-augmented requests.

For Rainy: you implement **tools + resources** (and optionally prompts). You *consume*
sampling/elicitation/roots only if you need them and the client advertises support.

## Lifecycle & handshake

Three phases: **Initialization → Operation → Shutdown.**

1. **Client → `initialize` request** with its `protocolVersion`, `capabilities`, and
   `clientInfo`.
2. **Server → `initialize` response** with the agreed `protocolVersion`, its own
   `capabilities`, `serverInfo`, and an optional `instructions` string.
3. **Client → `notifications/initialized`** — operation may now begin.

```json
// client → server
{ "jsonrpc": "2.0", "id": 1, "method": "initialize",
  "params": {
    "protocolVersion": "2025-11-25",
    "capabilities": { "roots": {"listChanged": true}, "sampling": {}, "elicitation": {} },
    "clientInfo": { "name": "ExampleClient", "version": "1.0.0" }
  } }

// server → client
{ "jsonrpc": "2.0", "id": 1,
  "result": {
    "protocolVersion": "2025-11-25",
    "capabilities": {
      "tools": {"listChanged": true},
      "resources": {"subscribe": true, "listChanged": true},
      "prompts": {"listChanged": true},
      "logging": {}
    },
    "serverInfo": { "name": "Rainy", "version": "1.0.0" },
    "instructions": "Optional usage hints for the model"
  } }

// client → server (notification, no id)
{ "jsonrpc": "2.0", "method": "notifications/initialized" }
```

Rules:
- `initialize` **must** be the first interaction.
- Before init completes, neither side sends anything but `ping` (server may also send
  `logging`).
- Both sides **must** stick to the negotiated version and only use negotiated capabilities.

### Version negotiation

Client sends its latest supported version. If the server supports it, it echoes the same
string; otherwise it returns its own latest, and the client disconnects if it can't match.
Mismatch error:

```json
{ "jsonrpc": "2.0", "id": 1,
  "error": { "code": -32602, "message": "Unsupported protocol version",
             "data": { "supported": ["2025-11-25"], "requested": "1.0.0" } } }
```

### Capability negotiation

Capabilities are objects, enabling sub-flags:

- `listChanged` — server will emit list-changed notifications (tools/resources/prompts).
- `subscribe` — clients can subscribe to individual resource changes (resources only).
- Server caps: `tools`, `resources`, `prompts`, `logging`, `completions`, `tasks`,
  `experimental`.
- Client caps: `roots`, `sampling`, `elicitation`, `tasks`, `experimental`.

Only advertise what you actually implement.

### Shutdown

No shutdown RPC — the **transport** signals termination.
- **stdio**: client closes the server's stdin, waits, then `SIGTERM` → `SIGKILL` if
  needed. The server may also self-terminate by closing stdout and exiting.
- **HTTP**: close the HTTP connection(s) (or send `DELETE` to end a session).

## JSON-RPC framing

- All messages are JSON-RPC 2.0, **UTF-8**.
- **Requests** carry `id` + `method` (+ `params`) and expect a response.
- **Notifications** carry `method` (+ `params`), **no `id`**, no response.
- **Responses** carry the matching `id` and either `result` or `error`.
- Standard error codes apply (`-32700` parse, `-32600` invalid request, `-32601` method
  not found, `-32602` invalid params, `-32603` internal).

Common method names: `initialize`, `notifications/initialized`, `tools/list`,
`tools/call`, `resources/list`, `resources/read`, `resources/templates/list`,
`prompts/list`, `prompts/get`, `ping`, `notifications/*` (progress, cancelled,
list-changed, message/logging).

## Transports

### stdio (use this for Rainy)

- Host launches the server as a **subprocess**; reads `stdout`, writes `stdin`.
- Each message is one JSON-RPC object on a single line, **newline-delimited**, and
  **must not contain embedded newlines**.
- The server **must not** write anything to `stdout` that isn't a valid MCP message —
  a stray `print()` corrupts the stream. Logging goes to **`stderr`** (which the client
  may capture/forward/ignore and **must not** treat as error signal by itself).
- Clients **should** support stdio whenever possible; it's the canonical local transport.

### Streamable HTTP (the remote transport)

- Single MCP endpoint path (e.g. `https://host/mcp`) handling **POST and GET**.
- Client POSTs JSON-RPC; server replies either `application/json` (one object) or
  `text/event-stream` (SSE stream that eventually carries the response and may interleave
  server→client requests/notifications). Client `Accept` header must list both.
- JSON-RPC responses/notifications POSTed to the server get **`202 Accepted`** (no body).
- **GET** opens an SSE stream for unsolicited server→client messages.
- **Sessions**: server may issue an `MCP-Session-Id` header on the init response; client
  must echo it on every later request. `404` on a session id means "reinitialize."
  `DELETE` ends a session.
- **`MCP-Protocol-Version` header**: client must send it on every post-init HTTP request
  (e.g. `MCP-Protocol-Version: 2025-11-25`). Missing → server assumes `2025-03-26`;
  invalid → `400`.
- **Security (server author's job)**: validate the `Origin` header (`403` if invalid) to
  block DNS-rebinding; bind to `127.0.0.1` for local servers; add real auth.
- Resumability: SSE event `id`s + `Last-Event-ID` on reconnect let the server replay a
  dropped stream.
- This **replaces** the deprecated 2024-11-05 HTTP+SSE two-endpoint transport; backwards
  compatibility is possible but optional.

## Server author: implement vs. FastMCP handles

**FastMCP handles for you:**
- JSON-RPC framing/parsing, newline delimiting, UTF-8.
- The full handshake: `initialize`/`initialized`, version & capability negotiation,
  `serverInfo`.
- Dispatch of `tools/list`, `tools/call`, `resources/list`/`read`,
  `resources/templates/list`, `prompts/list`/`get`, `ping`.
- Generating tool/resource input & output JSON schemas from your type hints.
- stdio and Streamable HTTP transports, including `Origin` validation and session IDs on
  HTTP; routing logs to stderr.
- Cancellation, progress, logging plumbing exposed via `Context`.

**You implement:**
- The actual tool/resource/prompt **functions** (the Rainy app logic + the IPC bridge to
  the app), with good type hints and docstrings.
- Sensible URIs for resources/templates.
- Error semantics (`ToolError` for user-facing failures; decide on `mask_error_details`).
- Which capabilities to *use* (sampling/elicitation/roots) and graceful fallback when the
  client didn't advertise them.
- For HTTP only: auth, localhost binding, and not exposing the server beyond intended
  trust boundary. (stdio inherits the local user's trust.)
- The transport-side security/consent posture the spec demands: tools are arbitrary code
  execution, so destructive tools should be clearly described and, ideally, gated by host
  confirmation.

## Sources

- MCP Specification (index): https://modelcontextprotocol.io/specification
- Lifecycle (2025-11-25): https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle
- Transports (2025-11-25): https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- Architecture (2025-11-25): https://modelcontextprotocol.io/specification/2025-11-25/architecture
- Schema repo: https://github.com/modelcontextprotocol/specification
- 2026 roadmap (beta/RC, flag as uncertain): https://blog.modelcontextprotocol.io/posts/2026-mcp-roadmap/
- JSON-RPC 2.0: https://www.jsonrpc.org/specification
