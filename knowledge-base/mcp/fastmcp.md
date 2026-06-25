# FastMCP (Python) Guide

_Last updated: 2026-06-24_

Practical reference for building an MCP **server** with FastMCP, oriented toward
Rainy's case: a macOS app that spawns a Python + FastMCP server over **stdio** so a
local Claude Code instance can read app data and drive the app.

## Version landscape (as of 2026-06)

- **Current stable: FastMCP `3.4.x`** (3.4.2 released 2026-06-06). Apache-2.0,
  maintained by Jeremiah Lowin / Prefect. Requires **Python >= 3.10** (3.10–3.13).
- **FastMCP 1.x** was folded into the official `mcp` Python SDK (`mcp.server.fastmcp`).
  That bundled copy is frozen at the 1.x feature set. For new work use the standalone
  `fastmcp` package, **not** the SDK's bundled FastMCP.
- **FastMCP 2.x** added clients, server proxying/composition, OpenAPI/FastAPI
  integration, auth providers.
- **FastMCP 3.x** is the current line. Notable: the decorator is now used **bare**
  (`@mcp.tool`, not `@mcp.tool()`), first-class auth/token verifiers, structured output
  by default from return types, and `Client` dependency-injection helpers
  (`CurrentContext`). ⚠️ Some 3.x API surface (exact import paths like
  `fastmcp.dependencies.CurrentContext`, `ResourceResult`/`PromptResult`) moves between
  minor releases — pin a version and verify against the installed package.

Pin it: `fastmcp>=3.4,<4` in your dependency manifest.

## Install

```bash
# uv (recommended)
uv pip install fastmcp
# or
pip install fastmcp

fastmcp version   # sanity check
```

## Minimal complete server (stdio)

This is a self-contained server exposing two tools and one resource. This is the shape
Rainy's bundled server should take.

```python
# rainy_mcp/server.py
from fastmcp import FastMCP, Context
from fastmcp.exceptions import ToolError

mcp = FastMCP(
    name="Rainy",
    instructions="Read Rainy app data and drive the app. Tools mutate app state.",
)

@mcp.tool
def list_notes(limit: int = 20) -> list[dict]:
    """List the most recent notes in the Rainy app."""
    return read_notes_from_app(limit)        # your app-bridge call

@mcp.tool
def create_note(title: str, body: str = "") -> dict:
    """Create a new note and return it."""
    if not title.strip():
        raise ToolError("title must not be empty")
    return write_note_to_app(title, body)

@mcp.resource("rainy://notes/{note_id}")
def get_note(note_id: str) -> str:
    """Return a single note's body as plain text."""
    return load_note_body(note_id)

if __name__ == "__main__":
    mcp.run()          # stdio transport (default)
```

Run it / register it with Claude Code:

```bash
python -m rainy_mcp.server          # direct
fastmcp run rainy_mcp/server.py     # via CLI, auto-detects `mcp` object
```

Claude Code / Claude Desktop config (the host launches this as a subprocess):

```json
{
  "mcpServers": {
    "rainy": {
      "command": "python",
      "args": ["-m", "rainy_mcp.server"],
      "env": { "RAINY_SOCKET": "/tmp/rainy.sock" }
    }
  }
}
```

For Rainy specifically: the macOS app launches the Python process and connects the
client to its stdin/stdout. The Python server talks to the app over your own IPC channel
(socket / XPC / local HTTP) — that bridge is separate from MCP.

## Tools — `@mcp.tool`

FastMCP derives the tool name from the function name, the description from the docstring,
and the JSON input schema from type annotations.

```python
from typing import Annotated, Literal
from pydantic import Field

@mcp.tool
def search(
    query: Annotated[str, "Full-text query"],
    scope: Literal["notes", "tasks", "all"] = "all",
    limit: Annotated[int, Field(ge=1, le=100)] = 20,
) -> list[dict]:
    """Search Rainy content."""
    ...
```

- Params **without defaults are required**; with defaults are optional.
- `Annotated[T, "..."]` adds a description; `Field(...)` adds validation
  (`ge`, `le`, `min_length`, patterns, etc.).
- Supported types: scalars, `list`/`dict`, `Optional`, `Union`, `Literal`, enums,
  `Path`, `UUID`, dataclasses, and **Pydantic models** (nested objects validate).
- Tools may be `async def` — preferred for I/O so the event loop isn't blocked.
- Override naming/metadata: `@mcp.tool(name="...", tags={"read"}, annotations={...})`.

### Structured output & return types

FastMCP populates both the human-readable `content` and machine-readable
`structuredContent` of the MCP result from your return annotation.

```python
from dataclasses import dataclass

@dataclass
class Note:
    id: str
    title: str
    body: str

@mcp.tool
def get_note_obj(note_id: str) -> Note:
    """Returns a structured Note."""
    return Note(id=note_id, title="...", body="...")
```

- Objects (dataclass / Pydantic / `dict`) → serialized to JSON in `structuredContent`.
- Primitives (`int`, `str`, `bool`) → wrapped under a `"result"` key so the structured
  output is still a valid JSON object.
- Custom schema when you need it: `@mcp.tool(output_schema={...})`.

### Errors

```python
from fastmcp.exceptions import ToolError

@mcp.tool
def divide(a: float, b: float) -> float:
    if b == 0:
        raise ToolError("Division by zero is not allowed.")  # message reaches client
    return a / b
```

- Any exception is logged and returned to the client as an MCP tool error.
- `ToolError` messages **always** reach the client (use it for user-facing failures).
- Construct the server with `FastMCP(..., mask_error_details=True)` to hide internal
  exception details (recommended for anything handling untrusted input); `ToolError`
  text still passes through.

## Resources — `@mcp.resource`

Read-only data, addressed by URI. Good for exposing Rainy's data for the model to pull
on demand (cheaper than a tool call when no computation is needed).

```python
import json

@mcp.resource("rainy://config", mime_type="application/json")
def get_config() -> str:
    return json.dumps({"theme": "dark"})

# Templated resource — {placeholders} become function params
@mcp.resource("rainy://note/{note_id}")
def note_resource(note_id: str) -> str:
    return load_note_body(note_id)
```

- Return `str` (text), `bytes` (base64 binary — set `mime_type`), or a `ResourceResult`
  for full control over multiple contents + `meta`. ⚠️ `ResourceResult`/`ResourceContent`
  import path is 3.x-specific — verify against your installed version.
- Wildcards: `rainy://files/{path*}` matches multiple path segments.
- Optional query params: `rainy://data/{id}{?format}` with `format: str = "json"`.
- Templated resources mint a new resource per unique parameter set — no pre-registration.

## Prompts — `@mcp.prompt`

Reusable, parameterized message templates the host can surface to the user.

```python
from fastmcp.prompts import Message

@mcp.prompt
def summarize_note(note_id: str) -> str:
    """Ask the model to summarize a note."""
    return f"Summarize Rainy note {note_id} in three bullet points."

@mcp.prompt
def review(code: str) -> list[Message]:
    return [
        Message(f"Review this:\n{code}"),                  # defaults to role="user"
        Message("I'll analyze it.", role="assistant"),
    ]
```

Function params become prompt arguments (no-default = required). Return a `str`, a
`list[Message]`, or a `PromptResult` (messages + `meta`).

## Context object

Add a `Context` parameter to a tool/resource/prompt to reach back into the session:
logging, progress, resource reads, sampling, elicitation, request metadata.

```python
from fastmcp import Context

@mcp.tool
async def reindex(ctx: Context) -> dict:
    await ctx.info("starting reindex")          # log to client
    items = await ctx.read_resource("rainy://config")
    await ctx.report_progress(progress=50, total=100)
    # Ask the host's LLM to do work (requires client `sampling` capability):
    summary = await ctx.sample("Summarize the config")
    await ctx.report_progress(progress=100, total=100)
    return {"summary": summary.text}
```

Two access styles:
- **Parameter injection** — `ctx: Context` (simplest; also the DI form
  `ctx: Context = CurrentContext()` in 3.x).
- `get_context()` for code called outside the handler signature.

`ctx.sample(...)` and `ctx.elicit(...)` only work if the connected client advertised the
`sampling` / `elicitation` capability. Claude Code / Claude Desktop support both, but
guard for absence.

## Lifespan / startup state

Open shared resources once (DB pool, the IPC handle to the Rainy app) at startup and
expose them to handlers. FastMCP uses the standard async-context-manager lifespan:

```python
from contextlib import asynccontextmanager
from dataclasses import dataclass
from fastmcp import FastMCP, Context

@dataclass
class AppState:
    bridge: "RainyBridge"

@asynccontextmanager
async def lifespan(server: FastMCP):
    bridge = await RainyBridge.connect()   # startup
    try:
        yield AppState(bridge=bridge)      # available to handlers
    finally:
        await bridge.close()               # shutdown

mcp = FastMCP(name="Rainy", lifespan=lifespan)

@mcp.tool
async def ping(ctx: Context) -> str:
    state: AppState = ctx.request_context.lifespan_context
    return await state.bridge.ping()
```

⚠️ The exact accessor (`ctx.request_context.lifespan_context`) tracks the underlying MCP
SDK and has been stable, but confirm against your installed FastMCP/SDK version.

## Running: stdio vs HTTP

```python
mcp.run()                                              # stdio (default) — use this for Rainy
mcp.run(transport="http", host="127.0.0.1", port=8000) # Streamable HTTP at /mcp
```

CLI equivalents: `fastmcp run server.py` (stdio), `fastmcp run server.py --transport http`.

- **stdio**: host launches the server as a subprocess; one process per client. Correct
  choice for a desktop app bundling a local server. ⚠️ **Never `print()` to stdout** —
  stdout is the MCP channel and stray output corrupts the protocol. Log to **stderr**
  (FastMCP's logging / `ctx.*` does this for you) or a file.
- **HTTP (Streamable HTTP)**: long-lived process, multiple concurrent clients. Bind to
  `127.0.0.1` only and validate `Origin` (FastMCP does the latter). Use only if you want
  the server to outlive / be shared across clients.

## Auth (HTTP transport only)

Auth applies to the HTTP transport; **stdio inherits the trust of the local user**, so
Rainy's stdio server typically needs no MCP-level auth (rely on OS process boundaries).

For HTTP, FastMCP provides token verification and OAuth provider integrations:

```python
from fastmcp.server.auth import StaticTokenVerifier   # ⚠️ path varies by version

mcp = FastMCP(name="Rainy", auth=StaticTokenVerifier(tokens={"dev-token": {...}}))
```

- `TokenVerifier` does pure token validation (JWT signature, expiry, issuer/audience,
  claim extraction) without hosting OAuth metadata.
- Test helpers like `StaticTokenVerifier` / `DebugTokenVerifier` exist for local dev.
- Full OAuth/OIDC provider integrations exist for production remote servers.
- ⚠️ Auth import paths and class names have shifted across 2.x→3.x; verify against the
  installed version.

## Testing

Test in-memory by passing the server object straight to a `Client` — no subprocess, no
stdio, full speed:

```python
import pytest
from fastmcp.client import Client
from rainy_mcp.server import mcp

@pytest.fixture
async def client():
    async with Client(transport=mcp) as c:     # in-memory transport
        yield c

async def test_create_note(client):
    result = await client.call_tool("create_note", {"title": "hi", "body": "yo"})
    assert result.data["title"] == "hi"        # `.data` = deserialized structured output

async def test_list_resources(client):
    res = await client.read_resource("rainy://config")
    assert res
```

`Client` also supports `list_tools()`, `list_resources()`, `get_prompt()`, etc. Run with
`pytest` + `pytest-asyncio` (or `anyio`).

## Rainy checklist

- Use standalone `fastmcp>=3.4,<4`, Python >=3.10.
- `mcp.run()` (stdio); never write non-MCP bytes to stdout.
- Open the app-IPC bridge in a `lifespan`; read it via `ctx.request_context.lifespan_context`.
- Read-only app data → `@mcp.resource`; actions that mutate app state → `@mcp.tool`.
- Raise `ToolError` for user-facing failures; set `mask_error_details=True`.
- Test in-memory with `Client(transport=mcp)`.

## Sources

- FastMCP docs — Welcome: https://gofastmcp.com/getting-started/welcome
- FastMCP docs — Tools: https://gofastmcp.com/servers/tools
- FastMCP docs — Resources: https://gofastmcp.com/servers/resources
- FastMCP docs — Prompts: https://gofastmcp.com/servers/prompts
- FastMCP docs — Context: https://gofastmcp.com/servers/context
- FastMCP docs — Running the server: https://gofastmcp.com/deployment/running-server
- FastMCP docs — Testing: https://gofastmcp.com/patterns/testing
- FastMCP docs — Authentication: https://gofastmcp.com/servers/auth/authentication
- FastMCP on PyPI (version/release): https://pypi.org/project/fastmcp/
- FastMCP GitHub: https://github.com/jlowin/fastmcp
- MCP Python SDK (bundled FastMCP 1.x): https://github.com/modelcontextprotocol/python-sdk
