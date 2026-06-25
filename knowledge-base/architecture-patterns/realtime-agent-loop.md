# Real-Time Agent Loop: Driving the Canvas via MCP

_Last updated: 2026-06-24_

How fast can an AI agent drive Rainy's infinite canvas through MCP, and what loop
architecture makes it *feel* real-time? This doc analyzes the **agent-loop latency and
mechanics** — the piece the existing docs don't cover. It builds on, and does not
duplicate:

- `knowledge-base/architecture-patterns/realtime-app-ipc.md` — the **transport** (reuse
  the stdio pipe; JSON-RPC notifications → `AsyncStream` → `@MainActor @Observable`).
- `knowledge-base/mcp/claude-code-mcp-integration.md`, `…/fastmcp.md` — MCP wiring.
- `knowledge-base/models/realtime-fast-models.md` — the **model menu** (Groq/Cerebras/
  Haiku/Codex-Spark/on-device) and the tiered router. (Decisions D7, R7, R8.)

This doc answers: *given* that transport and *given* that model menu, **who runs the
loop, how many tool calls, and what is the latency budget per UX tier.**

> **Confidence legend:** ✅ confirmed (primary/official) · 🟡 reported (reputable
> secondary) · 🔶 inferred/order-of-magnitude. Latency figures vary by load, context
> size, and model; treat all numbers as *budgets*, not guarantees. Profile your own.

---

## TL;DR / Recommendation

1. **MCP is client-driven.** The MCP *server* (Rainy's FastMCP sidecar) **cannot push work
   into the agent**; the *client* (the agent loop) decides when to call tools. So
   "real-time editing" is bounded entirely by **the agent loop**, not by MCP. ✅ (MCP spec)
2. **Claude Code's interactive loop is NOT a real-time editing engine.** Each turn is a
   full model round-trip; per-tool-call step latency is **~300–800 ms** and tasks routinely
   chain **8–20+ sequential round-trips → 7–15 s** of wall-clock. 🟡 Great for *heavy*
   board generation and reasoning; wrong tool for sub-second live nudges.
3. **Yes — you can drive the loop programmatically.** The **Claude Agent SDK** (renamed
   from "Claude Code SDK" in Sept 2025) runs the *same* loop headless, in Python/TS, with
   a custom system prompt, a pinned (possibly fast) model, your MCP tools, streaming
   output, and `maxTurns`/`maxBudgetUsd` caps. RAINY controls the loop; the user never
   types. ✅
4. **Design (d) verdict — ONE batch beats MANY small calls, decisively.** N tool calls =
   N model round-trips = N × (300–800 ms). ONE structured response carrying all canvas ops
   (either N parallel `tool_use` blocks in a single turn, or one `apply_canvas_ops(ops=[…])`
   call) = **one** round-trip; the **app animates the ops in** at 120 Hz. The agent's job
   is to *emit a plan*; the *app* owns the real-time feel. ✅🔶
5. **Recommended architecture:** a **two-engine** loop. **Engine A (Agent SDK, host-pinned
   model)** generates/edits boards as *batched op-lists* (seconds; that's fine). **Engine B
   (direct fast-model call — Groq/Cerebras/Haiku/on-device, NO agent loop)** handles the
   live hot path with streaming structured ops. Both write the same op format; the **app**
   is the only thing that touches the canvas at frame rate. The MCP/Claude-Code path is
   Engine A's *delivery mechanism*, not the real-time mechanism.

---

## 1. The load-bearing constraint: MCP is client-driven

MCP defines a **client** (the agent/host) and a **server** (your tools). The protocol flow
is **request → response**: the client calls `tools/call`, the server returns a result. The
server may also emit **notifications** (no `id`, fire-and-forget) — but those are *outbound
status*, not a way to make the client do work. **There is no server-initiated "please call
this tool" primitive.** ✅ (MCP spec, transports/basic.)

Consequence for Rainy: the canvas does **not** get edited "by MCP." It gets edited by an
**agent loop that decides to call a mutate tool**. The cadence, count, and latency of those
edits are properties of **the loop**, not of MCP/stdio. The stdio pipe is fast (below); the
loop is the bottleneck.

> This is *why* `realtime-app-ipc.md` is necessary but not sufficient: that doc makes the
> *notification* (server→app, "canvas changed") instant. This doc is about the *decision*
> (agent→server, "change the canvas") which is the slow part.

---

## 2. Claude Code's agentic loop latency in practice

### 2.1 The loop shape (Agent SDK docs, ✅)

Every session: **receive prompt → evaluate → (text and/or one-or-more tool calls) →
execute tools → feed results back → repeat until a response has no tool calls → return
`ResultMessage`.** "A turn is one round trip… Claude continues calling tools and processing
results until it produces a response with no tool calls." A quick task = 1–2 turns; a
complex one "can chain dozens of tool calls across many turns." ✅

Key mechanical facts:
- **Each turn is a full model inference** over the *entire accumulated context* (system
  prompt + tool defs + every prior tool input/output). Context "does not reset between
  turns… everything accumulates." ✅ So **turn N is slower than turn 1.**
- **Tool execution within a turn**: when Claude emits multiple `tool_use` blocks in one
  turn, read-only tools (incl. MCP tools annotated `readOnlyHint`) can run **concurrently**;
  state-mutating tools (`Edit`/`Write`/`Bash`) run **sequentially**. ✅
- Caps: `max_turns`/`maxTurns` (tool-use turns only), `max_budget_usd`, and `effort`
  (`low`→`max`) which "trades latency and token cost for reasoning depth." ✅

### 2.2 Measured latency (🟡, cross-source)

| Quantity | Figure | Source class |
|---|---|---|
| **Time-to-first-token, Claude small/fast tier** | **~0.3–0.5 s** median (Haiku 4.5 ~0.38 s; Anthropic's own self-report ~0.75–0.78 s) | 🟡 Artificial Analysis / vendor |
| **Per tool-call *step*** (model decide + tool exec + feed-back) | **~300–800 ms** | 🟡 practitioner blogs |
| **Typical multi-step task** | 8 calls ≈ **~7 s**; 20 calls ≈ **10–15 s** | 🟡 |
| **Vague prompt blow-up** | "15 exploratory tool calls and 12 s of wait" | 🟡 |
| **Context tax** | by turn ~30 a session can reprocess **~400k tokens** per call → progressively sluggish | 🟡 |
| **CLI cold start (`claude -p`)** | hundreds of ms typical; pathological 10–12 s when a network config fetch fails (a known bug class) | 🟡 |

**Interpretation:** Claude Code "feels fine at the start of a session and progressively
sluggish by the end" because slowness comes from **sequential round-trips × growing
context**, not raw model speed. ✅🟡 This is *fundamentally* incompatible with a per-frame
or per-node live-edit loop. It is *fine* for "generate me a board" (seconds, once).

**Is it designed for high-frequency tool calls?** No. It's designed to call as *few*
tools as it can to finish a task, and each call is a network round-trip on growing context.
High-frequency, low-latency calls are an anti-pattern here. Use it for **infrequent,
high-value, batched** mutations.

---

## 3. Driving the loop programmatically — the Claude Agent SDK

You do **not** need the interactive CLI or a human typist. Two embedding paths (✅):

### 3.1 CLI headless (`claude -p`) — simplest

```bash
claude --bare -p "Generate an ideation board for project X" \
  --model claude-haiku-4-5 \
  --append-system-prompt-file rainy_canvas_prompt.txt \
  --mcp-config rainy.mcp.json \
  --allowedTools "mcp__rainy__apply_canvas_ops,mcp__rainy__read_canvas" \
  --permission-mode dontAsk \
  --output-format stream-json --include-partial-messages --verbose
```

- **`--bare`** skips auto-discovery of hooks/skills/plugins/MCP/CLAUDE.md → **faster, deterministic** startup; "recommended for scripted and SDK calls," will become the `-p`
  default. Pass exactly the context you want via flags. ✅
- **`--model`** pins the model (use a fast one). ✅
- **`--system-prompt`** fully replaces / **`--append-system-prompt[-file]`** augments the
  prompt — make the agent a *canvas op emitter*, not a chatty assistant. ✅
- **`--output-format stream-json --include-partial-messages`** streams token/tool deltas as
  newline-delimited JSON you can parse as they arrive. ✅
- **`--permission-mode dontAsk`** / `--allowedTools` → **no permission prompts** (critical:
  a prompt would stall an unattended loop). ✅

### 3.2 Python/TS SDK — full programmatic control (recommended for Rainy's host)

`pip install claude-agent-sdk` (Python ≥3.10) / `npm i @anthropic-ai/claude-agent-sdk`.
Bundles a native binary; **no separate Claude Code install required.** ✅

**Streaming-input mode is the recommended mode** — a *long-lived* agent process that takes
input, handles **interruptions**, keeps session/context alive, and streams responses. This
is exactly Rainy's "open canvas, keep editing" shape. ✅

```python
from claude_agent_sdk import ClaudeSDKClient, ClaudeAgentOptions, AssistantMessage, ResultMessage

opts = ClaudeAgentOptions(
    model="claude-haiku-4-5",            # pin a FAST model
    system_prompt="You drive Rainy's canvas. Emit canvas ops via apply_canvas_ops. "
                  "Prefer ONE call with many ops over many calls. Never chat.",
    mcp_servers={"rainy": {...}},        # in-proc or stdio MCP; tools become mcp__rainy__*
    allowed_tools=["mcp__rainy__apply_canvas_ops", "mcp__rainy__read_canvas"],
    permission_mode="dontAsk",           # unattended: no prompts
    effort="low",                        # less reasoning, lower latency for routine edits
    max_turns=4, max_budget_usd=0.05,    # bound runaway loops
    include_partial_messages=True,       # stream deltas for incremental UI
)

async with ClaudeSDKClient(opts) as client:      # persistent session; context survives turns
    await client.query("Add 5 competitor nodes around the selected outlier")
    async for msg in client.receive_response():
        if isinstance(msg, ResultMessage):
            ...  # cost, usage, session_id (resume/fork later)
```

Other relevant levers (✅): **subagents** (fresh context per subtask, only the summary
returns — keeps the main loop lean for board-wide ops); **hooks** (`PreToolUse` to
validate/transform an op before it hits the canvas, runs in *your* process, no context
cost); **sessions** (capture `session_id` to resume/fork a board's editing history);
**in-process MCP servers** ("custom tools… run directly within your Python application,
eliminating the need for separate processes") — relevant if you co-locate the agent and the
sidecar.

**Bottom line (b):** Rainy *can* own the loop end-to-end. But owning Claude Code's loop
doesn't make it fast — see §2. The SDK's value here is **batch board generation and
reasoning edits**, run with a pinned model, streaming, and hard caps.

---

## 4. MCP stdio tool-call round-trip latency (local)

The transport is **not** the bottleneck. Local stdio:

- **Kernel pipe one-way ≈ tens of µs**; a full MCP `tools/call` round-trip over local stdio
  is **single-digit milliseconds**, dominated not by the pipe but by **FastMCP/CPython
  session overhead**. 🟡
- FastMCP per-request overhead benchmarks: **~26 ms/req single-worker**, the bottleneck is
  "FastMCP's session overhead in CPython," not the transport. 🟡 (That figure is HTTP-path
  throughput testing; the stdio JSON-RPC dispatch is in the same low-ms class.)
- For comparison, Streamable-HTTP adds **~5–25 ms** RT vs stdio. 🟡 → stdio is the right
  call (already locked, D4).

**So the tool-call mechanics cost single-digit-to-low-tens of ms.** Against a **300–800 ms**
model turn, **MCP overhead is noise (<5%).** Optimizing the pipe buys nothing; optimizing
*how many model turns you take* buys everything. This is the crux of §5.

> The *outbound* push (server→app "canvas changed") is even cheaper — a JSON-RPC
> notification on the same pipe, ~tens of µs (see `realtime-app-ipc.md`). The app re-renders
> at 120 Hz independent of the agent.

---

## 5. CRITICAL design (d): many small calls vs one batch

Because MCP is client-driven and each tool call is gated behind a model turn, the cost
model is brutally simple:

| Design | Round-trips | Wall-clock for N=30 nodes | Perceived |
|---|---|---|---|
| **(i) one tool call per node** (`add_node` ×30) | up to **30 turns** (mutations serialize) | 30 × ~500 ms ≈ **~15 s**, nodes trickling | janky, model "typing" the board |
| **(ii) one batched response** — N `tool_use` blocks in **one turn**, *or* one `apply_canvas_ops(ops=[…30…])` | **1 turn** | ~1 × (model gen of the op-list) ≈ **~1–3 s** total, then **app animates** | smooth, "the board lays itself out" |

Why (ii) wins, concretely:
- **Latency:** N round-trips collapse to 1. "When Claude orchestrates 20+ operations in a
  single [batch], you eliminate 19+ inference passes." ✅ The 300–800 ms-per-step tax
  applies **once**, not per node.
- **Ordering/animation:** the app receives the *full* op-list atomically and can run a
  **staggered/animated insert** (`withAnimation`, per-node delay) at 120 Hz — *intentional*
  motion design instead of network-jitter trickle. The "real-time feel" is then a **render**
  property the app fully controls, not a model-cadence accident.
- **Correctness:** Claude makes fewer errors emitting one explicit op-list than juggling 30
  separate tool-result turns. ✅
- **Coalescing:** matches R4 ("agent applies small `Mutation` commands on `@MainActor`,
  coalesced per frame") — one op-list → coalesced frame batch.

**When *small* calls are still right:** a single live nudge ("make THIS node blue") is
genuinely one op — emit one op. The anti-pattern is *fanning a single intent into many
serialized tool calls*. Rule: **one user intent → one structured op-list**, regardless of
how many nodes it touches.

### 5.1 The op-list tool (sketch)

```python
# FastMCP server — ONE batch tool, structured ops
@mcp.tool
async def apply_canvas_ops(ctx: Context, ops: list[CanvasOp]) -> dict:
    """Apply a batch of canvas operations atomically. Prefer ONE call with many ops."""
    for op in ops:
        apply_locally(op)                                   # mutate server-side model
    write_sqlite(ops)                                        # durability (R2)
    # push to the live UI on the SAME stdio pipe (realtime-app-ipc.md)
    await ctx.session.send_notification("canvas/ops", {"ops": [o.dict() for o in ops]})
    return {"applied": len(ops)}
```

The app receives `canvas/ops` once, then **stages the animation itself**. The agent never
sees frame timing.

---

## 6. Latency budget by UX tier

Three tiers, three engines. **The model is in the loop for only two of them; never for
direct manipulation.**

| Tier | Trigger | Budget | Model in loop? | Engine | Path |
|---|---|---|---|---|---|
| **T0 — Direct manipulation** | user drags/zooms/types | **< 8 ms/frame (120 Hz); < 16 ms (60 Hz)** ✅ hard | **No** | SwiftUI only | `@Observable` world store + `Viewport` camera (R4). *No agent, no MCP, no SQLite on the hot path.* |
| **T1 — Agent-assisted live edit** | "make this blue", "tidy these 3", inline nudge | **TTFT < 400 ms; first visible op < ~600 ms; full small op-list < ~1.5 s** 🔶 target | **Yes (fast, NO agent loop)** | **Engine B**: direct streaming call to Groq/Cerebras small model or Haiku 4.5 (or on-device FM offline), structured-output ops | model streams an op-list → app animates as ops arrive |
| **T2 — Batch board generation** | "build an ideation board", "redesign this", competitor map | **first ops < ~2 s; full board 2–8 s**, progress shown 🔶 target | **Yes (agent loop OK)** | **Engine A**: Claude Agent SDK (pinned model, `effort:low`/`maxTurns`), or Claude Code via MCP | agent emits batched `apply_canvas_ops` (often via subagents) → app animates |

Notes:
- **T0 is sacred.** The agent must never sit between a user's gesture and a frame. R4's
  single-store + camera design already guarantees this; keep the agent path strictly
  *additive* (it produces ops; the renderer consumes them on its own schedule).
- **T1 target rationale:** a Groq/Cerebras small model gives **sub-100 ms TTFT** and
  **700–1800+ t/s** (`realtime-fast-models.md`), so a ~30-token op-list streams in well
  under a second → feels live. Haiku 4.5 (~0.38 s TTFT, ~110 t/s) is the quality-leaning
  fallback. **Critically, T1 does NOT use the agentic loop** — it's a *single* model call
  with tools/structured-output, so it dodges the §2 multi-turn tax entirely.
- **T2 tolerates seconds** — that's where Claude Code / Agent SDK belongs. Show a progress
  affordance; stream `AssistantMessage`s so the user sees "placing competitor nodes…".

---

## 7. Recommended loop architecture

```
                          ┌─────────────────────────────────────────────┐
   user gesture ──T0──────► SwiftUI render @120Hz  (NO model, NO MCP)    │
                          │   @Observable world store + Viewport (R4)    │
                          └──────────────▲──────────────────────────────┘
                                         │ canvas/ops notification (µs, stdio pipe)
                                         │ app ANIMATES ops in (withAnimation)
        ┌────────────────────────────────┴───────────────────────────────┐
        │                         CanvasOp bus                            │
        └───────▲───────────────────────────────────────▲────────────────┘
                │ batched op-list                        │ streamed op-list
   ┌────────────┴───────────────┐            ┌───────────┴──────────────────┐
   │ ENGINE A — Agent SDK       │            │ ENGINE B — fast single call   │
   │ (T2 board gen / reasoning) │            │ (T1 live edits)               │
   │ • Claude Agent SDK headless│            │ • Groq/Cerebras small model   │
   │ • pinned fast model        │            │   or Haiku 4.5 (streaming)    │
   │ • custom system prompt     │            │ • on-device FM when offline   │
   │ • MCP tools (mcp__rainy__*)│            │ • structured-output ops       │
   │ • effort:low, maxTurns cap │            │ • NO agentic loop (1 call)    │
   │ • subagents for big boards │            │ • NO MCP needed (direct SDK)  │
   └────────────────────────────┘            └───────────────────────────────┘
        seconds, batched, in background           sub-second, hot path
```

**Principles:**
1. **The app is the only real-time component.** Models *propose* ops; the renderer *decides*
   when frames happen. Decouples model latency from perceived latency entirely.
2. **One intent → one op-list.** Never fan an intent into serialized tool calls (§5).
3. **Two engines by latency class.** Don't force the live hot path through the agentic loop;
   don't force board generation through a context-less single call.
4. **MCP/Claude-Code = Engine A's delivery + the heavy-reasoning surface**, not the
   real-time mechanism. (Aligns with R8/D14: Claude Code owns its own pipe; the app-spawned
   sidecar owns the live one.)
5. **Cap everything**: `maxTurns`, `maxBudgetUsd`, `effort:low`, `--bare`, `dontAsk`,
   pre-approved `mcp__rainy__*` — an unattended loop must never stall on a prompt or
   runaway.
6. **Re-evaluate Engine B's model** as Codex-Spark (R7) gets a public API — it's the
   purpose-built fit for T1 but is preview-only today; Groq/Cerebras/Haiku are the
   buildable choices now.

### 7.1 Why not "just use Claude Code for everything"?
Because T1 through Claude Code's agentic loop = 300–800 ms × multiple turns + growing
context = **seconds**, which fails the live-edit budget. Claude Code is excellent at T2 and
at reasoning, useless at T0, and the wrong shape for T1. The two-engine split puts each tool
where its latency profile fits.

### 7.2 Open items to verify when implementing
- FastMCP **custom notification method** API for `canvas/ops` varies by version (flagged in
  `realtime-app-ipc.md`); built-in log/progress notifications are the stable fallback. Pin
  `fastmcp>=3.4,<4`.
- **Structured-output / tool-calling op format** parity across Engine B providers (Groq &
  Cerebras are OpenAI-compatible; Haiku via Messages API; on-device via Foundation Models
  guided generation) — keep the `CanvasOp` schema provider-agnostic.
- Measure **real per-turn latency on your actual context size** — the §2 numbers are
  cross-source; your tool-def + board-state context will move them.
- Codex-Spark API status (recheck; R7).

---

## Sources

- How the agent loop works — Agent SDK — https://code.claude.com/docs/en/agent-sdk/agent-loop
- Streaming Input (modes) — Agent SDK — https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode
- Run Claude Code programmatically (headless) — https://code.claude.com/docs/en/headless
- Agent SDK overview — https://code.claude.com/docs/en/agent-sdk/overview
- Connect to external tools with MCP (Agent SDK) — https://platform.claude.com/docs/en/agent-sdk/mcp
- claude-agent-sdk-python (GitHub) — https://github.com/anthropics/claude-agent-sdk-python
- Claude Agent SDK complete guide — https://hidekazu-konishi.com/entry/claude_agent_sdk_complete_guide.html
- Tool use with Claude (parallel tool_use blocks) — https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview
- Advanced tool use (batch orchestration) — https://www.anthropic.com/engineering/advanced-tool-use
- Why Does Claude Code Slow Down Over Time? (per-step / per-turn latency) — https://www.aakashx.com/blog/why-claude-code-is-slow/
- Why Is Claude Code Slow? Causes and Fixes (2026) — https://www.aakashx.com/blog/claude-code-slow-causes-fixes/
- Claude Code startup delay bug (12 s config fetch) — https://github.com/anthropics/claude-code/issues/11442
- MCP Transport: Stdio vs Streamable HTTP — latency benchmarks — https://www.truefoundry.com/blog/mcp-stdio-vs-streamable-http-enterprise
- MCP server performance tuning (250ms → sub-ms) — https://chatforest.com/guides/mcp-server-performance-tuning/
- Multi-language MCP server performance benchmark (FastMCP RPS/overhead) — https://www.tmdevlab.com/mcp-server-performance-benchmark.html
- MCP basic transports (stdio, notifications) — https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- Claude Haiku 4.5 (TTFT / t/s) — Artificial Analysis — https://artificialanalysis.ai/models/claude-4-5-haiku/providers
- AI model latency benchmarks 2026 (TTFT & TPS) — https://www.digitalapplied.com/blog/ai-model-latency-benchmarks-2026-ttft-throughput
- Groq vs Cerebras inference speed — https://artificialanalysis.ai/providers/groq
- Introducing Claude Haiku 4.5 — https://www.anthropic.com/news/claude-haiku-4-5
