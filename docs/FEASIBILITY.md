# Rainy — Feasibility Review (decision-grade)

_Last updated: 2026-06-24. Lead-architect synthesis of the knowledge-base research build + WWDC 2026._

This is the single document that answers the two questions the project keeps circling, plus the
two it must answer to ship: **(1) Is near-real-time agent-driven canvas editing feasible, and on
what model/loop architecture? (2) Is the download→analyze pipeline feasible, and what will hurt us?
(3) What did WWDC 2026 actually give us, and what do we adopt? (4) What is the tightened build
order?** It supersedes `docs/NEXT_STEPS.md` where they conflict (noted inline) and proposes
specific edits to `docs/DECISIONS.md`.

Confidence legend: **[C]** confirmed (primary/official) · **[R]** reported (reputable secondary) ·
**[E]** inferred/estimated. Everything macOS 27 / Xcode 27 / AFM 3 is **pre-release beta** today.

Source docs (read these for depth — this file does not repeat them):
`architecture-patterns/realtime-agent-loop.md`, `models/realtime-fast-models-deep.md`,
`ai-on-device/foundation-models-as-agent-driver.md`, `canvas/live-collaboration-architecture.md`,
`architecture-patterns/pipeline-feasibility-and-caveats.md`,
`apple-platform/wwdc-2026-developer-tools.md`, plus `architecture-patterns/realtime-app-ipc.md`
and `canvas/infinite-canvas-swiftui.md`.

---

## 0. Bottom line

**Near-real-time agent editing is feasible — but only if you stop trying to make the _agent_
real-time and make the _app_ real-time.** The hero "live brainstormed canvas" must NOT run on
Claude Code's agentic loop; that loop is architecturally disqualified for live editing (sequential
round-trips × growing context = 7–15 s for a multi-step task, and no model swap fixes it). The
escape is a **two-engine split where the app owns the frame clock**: models only ever _propose
batched canvas ops_; the `@MainActor` renderer decides when frames happen, so even a 1–3 s board
generation _feels_ alive at 120 Hz.

The pipeline is **comfortably feasible on compute and cost** (scene detection in seconds, on-device
VLM free, a full 100-video cloud run ~$5–15). Its real blocker is **legal/ToS**: a Jan 2026 DMCA
§1201 ruling makes a bundled third-party-URL downloader the dominant risk. **The defensible product
is bring-your-own-file analysis**, with URL download scoped to the user's own content and never
marketed as the hero.

WWDC 2026 shipped almost exactly the pieces Rainy needs — MCP is now Apple's universal agent seam,
Foundation Models v3 is a provider-agnostic Swift LLM layer with a real on-device fast lane and
on-device image VLM, and `container` machines give the Python pipeline a clean arm64 home. **A
dedicated local ultra-fast model ("Codex Spark") is NOT required to ship** and cannot be relied on
(no public API, text-only, shaky structured output). On-device covers the offline floor; fast-cloud
covers the quality/throughput ceiling.

---

## 1. Near-real-time canvas editing — verdict + architecture

### 1.1 Verdict

**Feasible, with caveats. The literal framing in the project brief — "real-time agent editing via
Claude Code over MCP" — is INFEASIBLE and must be retired.** Two load-bearing facts:

1. **MCP is client-driven [C].** The FastMCP server _cannot push work into the agent_; only the
   client (the agent loop) decides when to call a tool. So "real-time over MCP" is bounded entirely
   by the loop, never by the pipe. The stdio transport is single-digit-to-low-tens of ms — <5% of a
   single model turn. **The transport is never the bottleneck; turn count is everything.**
2. **Claude Code's loop is sequential round-trips over growing context [R].** ~300–800 ms per
   tool-call step × 8–20+ steps = 7–15 s wall-clock, worsening as context accumulates (~400k tokens
   reprocessed by turn ~30). This is an _architecture_ property, not a model-speed one — pinning a
   faster model does not rescue it for live editing.

### 1.2 Recommended architecture: app owns real-time; two engines feed one op bus

```
   user gesture ──T0──► SwiftUI render @120Hz (NO model, NO MCP, NO SQLite on hot path)
                        @Observable world store + Viewport camera (R4)
                                   ▲
                                   │  canvas/ops notification (µs) · app ANIMATES ops in (withAnimation)
        ┌──────────────────────────┴───────────────────────────────┐
        │                     CanvasOp bus (single @MainActor funnel)│
        └──────▲───────────────────────────────────────▲────────────┘
               │ batched op-list                        │ streamed op-list
   ┌───────────┴────────────────┐          ┌────────────┴───────────────────┐
   │ ENGINE A — Claude Agent SDK│          │ ENGINE B — direct fast-model call│
   │ T2 board gen / heavy edits │          │ T1 live edits                    │
   │ • headless, pinned model   │          │ • Groq gpt-oss-20B (mechanical)  │
   │ • effort:low, maxTurns cap │          │ • Gemini 3 Flash (minimal think) │
   │ • --bare, dontAsk          │          │   / Cerebras gpt-oss-120B (layout)│
   │ • ONE apply_canvas_ops(...) │          │ • Haiku 4.5 (must SEE keyframes) │
   │ • subagents for big boards │          │ • on-device AFM 3 = OFFLINE floor│
   │ seconds, backgrounded      │          │ • NO agent loop · NO MCP         │
   └────────────────────────────┘          └──────────────────────────────────┘
```

**Three latency tiers, three engines — the model is in the loop for only two:**

| Tier | Trigger | Budget | Engine / model | Loop? |
|---|---|---|---|---|
| **T0 — Direct manipulation** | drag / zoom / type | **< 8 ms/frame (120 Hz)** [C] hard SLA | SwiftUI only — `@Observable` store + camera | **No model** |
| **T1 — Agent-assisted live edit** | "make this blue", "tidy these 3", inline nudge | TTFT < 400 ms; first op < ~600 ms; full small op-list < ~1.5 s [E] _target_ | **Engine B**: a SINGLE streaming fast-model call, structured-output ops, **no agent loop, no MCP**. Groq gpt-oss-20B (mechanical) → Gemini 3 Flash `thinking_level:minimal` / Cerebras gpt-oss-120B (real layout) → Haiku 4.5 (vision) | Single call |
| **T2 — Board generation** | "build an ideation board", redesign, competitor map | first ops < ~2 s; full board 2–8 s with progress [E] _target_ | **Engine A**: Claude Agent SDK headless, pinned fast model, `effort:low`, `maxTurns`/`maxBudgetUsd`, `--bare` + `dontAsk`, ONE batched `apply_canvas_ops(ops=[...])` per intent | Agent loop (OK) |
| **T3 — Heavy async** | whole-board redesign, multi-step planning | seconds–minutes, async, progress affordance | **Claude Code over MCP** (delivery vehicle only) or a frontier model (Opus 4.8 / Gemini 3.1 Pro). **Never the real-time mechanism.** | Agent loop |
| **Offline floor** | no network / privacy flag | ~3–5 ops/sec, first op sub-second | **On-device AFM 3** Core Advanced, ONE batched `@Generable CanvasOpBatch`, streamed. Trivial single-op edits and simple maps only. | Single call |

### 1.3 The five settled answers to the brief's sub-questions

- **Claude Code-via-MCP vs Claude Agent SDK fast-model loop vs Codex-Spark vs on-device FM?**
  Claude Code over MCP = T3 heavy async + dev/power-user seam, never live. The **Claude Agent SDK
  headless** (same loop, run programmatically, pinned model, caps, streaming) = T2 board generation.
  A **direct fast-model call with no loop** = T1 hot path. **On-device FM** = offline/privacy floor
  only. **Codex-Spark = watchlist only** — no public API, text-only (can't see keyframes), and
  independently reported as unreliable on structured tool output [R]. It would be a future Engine-B
  swap-in _if_ it ships a public API with reliable structured output; do not architect around it.
- **Batch ops vs many small calls?** **One batch wins decisively.** N tool calls = N model
  round-trips (mutations serialize) ≈ 15 s for 30 nodes; ONE response carrying all ops = 1
  round-trip ≈ 1–3 s, then the app animates at 120 Hz. **Load-bearing rule: one user intent → one
  structured op-list.** Enforce this at the _tool surface_ (expose `apply_canvas_ops(ops=[...])`;
  do NOT expose `add_node`/`move_node` singletons to the agent) AND in the system prompt.
- **Is a local ultra-fast model required?** **No.** On-device AFM 3 covers the offline latency
  floor; Groq/Cerebras/Haiku cover the quality/throughput ceiling. Spark would only be an
  optimization, gated on an API that may never arrive.

### 1.4 The single biggest unbuilt risk: D14's two-writer topology

The canvas correctness proof (`live-collaboration-architecture.md` §7.6) rests on **exactly one
serialization point** — the `@MainActor apply()` reducer that assigns a monotonic Lamport order over
per-record last-write-wins registers. **D14 currently allows two co-equal live writers** (the
app-spawned router sidecar AND the Claude-Code-spawned instance), both mutating shared SQLite, and
the cross-instance notify path is _an admitted TODO_. If a second process writes SQLite out-of-band,
cross-instance ordering, the Lamport counter, and undo scoping all break — the single-serialization
guarantee does not hold across instances.

**Resolution (recommended, supersedes D14 as written):** collapse to **ONE live writer** — the
app-spawned sidecar that owns the `stdout → AsyncStream → @MainActor` pipe. Treat the
Claude-Code-spawned instance as a **second-class, non-real-time writer** that (a) persists to SQLite
and (b) pings the app over an authenticated `127.0.0.1` socket to trigger a re-fetch/replay through
the same `apply()` funnel — and accept those edits are NOT sub-second. Define the
**app-animated-vs-SQLite-committed transactional boundary** explicitly so a crash between "app
animated the ops" and "SQLite committed the ops" cannot desync the live mirror from the source of
truth.

### 1.5 Conflict & edit model (settled — no CRDT, no OT)

Single user + one agent against an authoritative SQLite store needs **neither CRDT nor OT** (Figma
and tldraw both rejected them with a central authority present). Adopt:
- **Per-(record, property) last-write-wins**, ordered by the `@MainActor` Lamport counter (Figma
  model, no wall-clock timestamps). Keep Excalidraw's `versionNonce` tiebreak only if ops ever apply
  off-main.
- **Typed `CanvasOp` enum** as the universal unit (agent emission, animation source, undo entry,
  optional op-log row). Batches share a `txnID` = one undo step.
- **Fractional-index string** for z-order — make `CanvasNode.z` TEXT, not float (reordering 1 of N
  nodes touches 1 record).
- **Tombstone snapshots** on delete for reversible undo without retaining dead rows.
- **Conflict policy:** soft-lock the node under an active user drag (agent geometry/text ops on it
  are dropped or ghosted); route destructive/bulk edits of _user_ content through a **suggestion
  ("ghost") layer** (accept ⌘↵ / reject ⌫); additive + agent-owned edits apply live and animated.
  Per-project autonomy slider; default additive=auto, destructive=suggest.
- **Animate agent edits** (`withAnimation` ~150–200 ms so they read as "the AI did this"); **apply
  user drags instantly, un-animated.** Coalesce agent ops per frame (dedupe `setPosition` per id to
  last). Persist to SQLite on a ~250–500 ms debounce, not per op.

---

## 2. Pipeline feasibility + caveats register

**Verdict: compute/cost are comfortably feasible; legal/ToS is the blocker.** Build the analysis
hero on a **bring-your-own-file** foundation.

> **OWNER OVERRIDE (DECISIONS D18):** the product owner has chosen **URL download as the marketed
> hero** despite the legal risk below — this is an informed, accepted product decision. The BYO-first
> recommendation in this section is therefore NOT adopted; the mitigations (720p cap,
> analyze-then-evict, auto-updating yt-dlp + honest failure UX, no bundled credentials) **still
> apply**, and counsel should be obtained before public launch. The analysis below stands as the
> risk record.

**Numbers worth pinning:**
- **Scene detection is not a bottleneck.** AdaptiveDetector ~3.5 s on short clips, ~36 s on long
  4K — and `auto_downscale` + `frame_skip` + a 720p source cap bring typical social videos to
  single-digit-to-tens of seconds [C]. Run it as a cancellable background sidecar job; skip clip
  splitting (it re-encodes) unless the product surfaces per-scene clips.
- **VLM cost at scale is benign with the optimized path:** on-device FM pre-screen (free) + 3
  keyframes/request + prompt caching + Batch API (−50%) + Haiku tier ≈ **$5.50 standard / $2.75
  batch per 50 videos; ~$11 / ~$5.50 per 100**; ~$0.0037/scene on Haiku 4.5. A full 100-video cloud
  run is **~$5–15 all-in** [C formula]. On-device-default path is ~$0 at the cost of background
  wall-clock.
- **On-device FM image throughput is the softest number** — Apple published NO per-image latency.
  Estimate ~0.8–2.4 s/frame (rapid mode = 9 img tokens; balanced = 144), ~3–8 min for a 200-frame
  video, fully local/free [E]. **Use FM for background/bulk; cloud for interactive-at-volume. MUST
  benchmark on M1 + M4 before any UX promise.**
- **Storage:** source media is ~99% of footprint (720p ~20 MB/min → ~16 GB/100 videos; 1080p ~40 GB)
  [C]. Default to **720p cap + "analyze-then-evict" source mp4** (keep `.info.json` for re-download)
  → ~5 MB/video AND lower legal exposure (not hosting others' media at rest). LRU size-budget cache.

**Caveats register (severity · confidence · mitigation):**

| # | Risk | Sev | Conf | Mitigation |
|---|---|---|---|---|
| 1 | **DMCA §1201 anti-circumvention** for bundled YouTube ripping (post-*Cordova v. Huneault*, MTD denied Jan 2026). Fair use does NOT cure circumvention; statutory damages $200–$2,500/act. | **Critical** | Confirmed (MTD denial; merits pending) | Make "import your own file" the default hero. Don't market a URL ripper. Don't ship a cipher-bypass/PO-token component as a headline feature. Scope URL download to user-owned content. **Get counsel before shipping any third-party download.** |
| 2 | **Platform ToS** (YouTube/TikTok/Instagram all prohibit downloading/scraping). | High | Confirmed | User-own-content posture; no bundled credentials; on-device default; takedown contact. Match Opus Clip / CapCut / Descript (none bundle a downloader). |
| 3 | **YouTube SABR / PO-token enforcement** breaks the simple download path; may need a JS-runtime PO-token provider. | High | Confirmed/ongoing | Auto-update yt-dlp to nightly; alternate `player_client`; honest "platform changed" failure UX. Accept outage windows. Shipping a PO-token minter raises §1201 exposure — weigh carefully. |
| 4 | **TikTok/Instagram extractor breakage** (recurring multi-day outages; IG login-walled). | High | Confirmed | Pin fresh yt-dlp + auto-nightly; `gallery-dl` fallback; throttle + serialize per platform; never promise reliability. |
| 5 | **No measured per-turn latency on Rainy's real context** (CanvasOp tool defs + live board state). T1/T2 budgets are targets, not validated. | High | Reported (cross-source, not SLAs) | Benchmark per-turn latency on the actual schema + board-state context before committing budgets. |
| 6 | **Structured-output op-format parity** across Engine B providers (Groq/Cerebras OpenAI-compatible vs Haiku `input_json_delta` vs on-device guided generation) is unproven. | High | — | Define ONE provider-agnostic `CanvasOp` schema; validate streaming structured output on each provider before the router is trustworthy. |
| 7 | **Gemini 3 Flash tools+JSON text-leak bug** (vercel/ai #11396): leaks internal JSON as text when tools are also provided. | High | Reported (open) | Reproduce/clear on Rainy's exact tools+schema before it carries the layout hot path; Cerebras (enforced schema) + Haiku (`input_json_delta`) are the most reliable fallbacks. |
| 8 | **Naive VLM fan-out cost** (every frame → separate full-res cloud call). | Medium | Confirmed | On-device pre-screen; 3-frames/request; prompt cache; Batch API; Haiku tier; downscale ~768 px. |
| 9 | **On-device FM image throughput unknown/unpublished** — could be too slow for "instant" on older Macs. | Medium | Estimated | Benchmark M1 + M4; FM for background, cloud for interactive-at-volume; per-job backend policy. |
| 10 | **Frames leave device** when escalating to Claude (third-party footage to a cloud vendor). | Medium | Confirmed | Per-job local-only/auto/cloud policy in settings; never silently send footage; default on-device. |
| 11 | **Storage bloat** from retained source video. | Medium | Confirmed | 720p cap; analyze-then-evict; LRU cache; surface footprint. |
| 12 | **Hardened-runtime entitlement set** for a bundled Python/ffmpeg is pre-2026 guidance, not re-validated for macOS 27; sandboxed/MAS may not spawn subprocesses at all. | Medium | Reported | Validate `allow-jit` / `disable-library-validation` / `allow-unsigned-executable-memory` against current Apple security docs; default to Developer-ID (non-MAS) or move pipeline into a container machine. |
| 13 | **FastMCP custom-notification (`canvas/ops`) API** varies by version. | Low (transport) | Reported | Pin `fastmcp>=3.4,<4`; built-in log/progress notifications as stable fallback; verify the Swift MCP client doesn't reject unknown notification methods. |
| 14 | **Auto-registered MCP server + `dontAsk` auto-approval** is a local-privilege surface — any local process reaching the socket/config can drive destructive tools. | High (security) | — | Bind socket to `127.0.0.1` only; require a per-launch token in the handshake; validate Origin; keep destructive tools OFF the auto-approved allowlist. |
| 15 | **Model-ID / pricing drift** (Opus 4.8 / Sonnet 4.6 / Haiku 4.5 / Fable 5 all current). | Low | Confirmed | Verify via the `claude-api` skill before wiring; don't hardcode prices in UX. |

---

## 3. Latest Apple developer tools (June 2026) — picture + what to adopt

WWDC 2026 (keynote Jun 8, SOTU Jun 9). Headline: **the pieces Rainy needs shipped.**

**Reconcile a doc discrepancy first:** the brief's "Swift 6.3.2 / macOS 28 SDK" is wrong against
public facts — **Xcode 27 beta ships Swift 6.4 + the macOS 27 SDK** [C]. There is no public macOS 28
SDK in June 2026. Correct the toolchain string in `docs/` to **Swift 6.4 / macOS 27 SDK**.

| Area | What shipped | Adopt for Rainy? |
|---|---|---|
| **Xcode 27** | Swift 6.4 + macOS 27 SDK; Apple-silicon-only; ~30% smaller; public ~Sept 2026. **Xcode is an MCP host** via an `mcpbridge` binary (MCP over XPC). Multi-provider Coding Intelligence (Claude/ChatGPT/Gemini + on-device ANE completion ~2.2 GB). Seven Apple agent skills exportable via `xcrun agent skills export`. | **Yes.** Confirms MCP is the right backbone — our FastMCP stdio server uses the same transport. Claude Code can drive both Rainy's MCP server and Xcode's `mcpbridge` in one session. Pull `swiftui-whats-new-27` skill into Claude Code sessions on this repo. |
| **Foundation Models v3 / AFM 3** | ~20B MoE, ~1–4B active; **on-device IMAGE input** (Core Advanced, ≥12GB RAM → M3+ Macs in scope); on-device `OCRTool`/`BarcodeReaderTool`/Spotlight RAG; **`LanguageModel` protocol** unifying on-device AFM 3, `PrivateCloudComputeLanguageModel` (32k ctx, free under 2M downloads), `CoreAILanguageModel` (ANE), `MLXLanguageModel` (Mac GPU, any HF MLX model), official Anthropic + Google Swift packages. Dynamic Profiles for mid-session model/tool switching. `fm` CLI + Python SDK (`apple_fm_sdk`). Open-sourcing summer 2026. | **Yes, heavily.** AFM 3 image-in = the **scene-analysis primary** (free, offline, `@Generable` typed streaming). `LanguageModelSession` = write canvas-editing logic once, swap backends (on-device / MLX / Claude) at the same call site. **PCC is an attractive privacy-preserving middle canvas tier.** The Python SDK is callable from the existing pipeline. |
| **Core AI** | New framework for custom on-device models (AOT compile, Instruments, PyTorch→ANE). | **Watch.** The path to a bespoke ANE canvas/router model ("real Codex Spark") if ever needed — not now. |
| **MLX** | Metal 4 + multi-Mac RDMA over Thunderbolt; `MLXLanguageModel` runs any HF MLX model on the Mac GPU through the same FM API. | **Optional.** Pragmatic local fast-lane alternative to a cloud T1 call when offline depth beats AFM 3 Core Advanced. |
| **`container` 1.0.0 + container machines** (WWDC26 #389) | Persistent, sub-second-start Linux VMs; automatic user/working-dir mapping; shared FS to `/Users`; per-machine IP. | **Strong candidate** for the yt-dlp/PySceneDetect/ffmpeg home — clean reproducible arm64 Linux, and it **sidesteps in-bundle interpreter signing** entirely. **Caveat:** VM I/O/encode overhead is real and unbenchmarked — keep the hot ffmpeg keyframe path native (arm64 ffmpeg / VideoToolbox) if latency-critical. |
| **Swift 6.4** | Ergonomics over Approachable Concurrency (single-threaded-by-default + `@concurrent`); async `defer`, task-cancellation shields, typed throwing `Task`, async `Result`, `anyAppleOS`. No breaking changes. | **Yes.** Adopt single-threaded-by-default; `@concurrent` for heavy lifts (frame decode, MCP I/O, SQLite writes off-main). Task-cancellation shields protect SQLite commit on agent-task cancel. |
| **SwiftUI 2026** | ~2× faster layout, lazy-stack prefetch/size-estimation (~120 fps reported), lazy `@State`, new SwiftUI Performance Instrument, native rich text (`TextEditor` + `AttributedString`), reorderable containers, swipe-actions-anywhere, new document protocols. **No dedicated infinite-canvas API; `ScrollView` gesture/zoom customization reportedly still unsolved.** | **Yes, but plan the canvas as NSScrollView/Metal/`Canvas`** for true pan-zoom — do NOT bet on `ScrollView`. Use `AttributedString` `TextEditor` for text nodes. Validate the ScrollView gesture status on a later 27 beta before committing. |
| **App Intents** | Now mandatory (SiriKit deprecated); expanded Actions API, View Annotations (on-screen awareness), App Intents Testing, third-party Visual Intelligence. | **Secondary seam.** Expose key canvas ops as App Intents → free Spotlight/Siri/Shortcuts entry points, a non-MCP agent surface. Lower priority than the MCP/FM router. |
| **Distribution** | arm64-only binaries allowed on MAS; Liquid Glass adoption **forced on recompile** (opt-out removed). No new notarization/entitlement requirement surfaced — but bundling Python/ffmpeg still needs hardened-runtime JIT/library-validation entitlements + per-binary signing. | **Default to Developer-ID (non-MAS)** for the bundled-pipeline build, or move the pipeline into a container machine. **Audit all chrome after the SDK bump** (forced Liquid Glass); glass on chrome only, never canvas content. |

Most "[R]"-flagged specifics (mcpbridge internals, the seven skill names, ~2.2 GB completion model,
AFM 3 20B/1–4B figures, 2× layout / 120 fps) are corroborated across secondary sources but not yet
pinned to Apple primary docs — re-verify at GM.

---

## 4. Tightened, sequenced build plan (supersedes NEXT_STEPS where noted)

Ordered so each step de-risks the one after it. **Bold = changed or added vs `NEXT_STEPS.md`.**

**Phase 0 — Decisions & toolchain (do first; cheap, unblocks everything)**
- **0.1 Correct the toolchain string** in `docs/` to **Swift 6.4 / macOS 27 SDK** (DECISIONS D3). [supersedes the brief's 6.3.2 / macOS 28]
- **0.2 Resolve OQ1/data-source as bring-your-own-file FIRST** (drag-drop local mp4 = the safe core), URL download a scoped, unmarketed power-user path for user-owned content. [reframes NEXT_STEPS step 0]
- **0.3 Resolve D14 to a single live writer** (§1.4). Rewrite D14 + R1-revised: app-spawned sidecar owns the live pipe; Claude-Code instance is a non-real-time writer via SQLite + authenticated localhost socket. **Define the animated-vs-committed transactional boundary.**
- **0.4 Get legal counsel** on any third-party download before it ships (caveat #1).

**Phase 1 — App skeleton + canvas spine**
- 1.1 Xcode 27 project (`app/`), SwiftUI macOS 27, `WindowGroup(id:"main")` + `MenuBarExtra(.window)`, `.accessory`→`.regular`, `terminateWhenLastWindowClosed = false`. Adopt single-threaded-by-default concurrency.
- 1.2 **`CanvasOp` enum + `OpEnvelope` + the single `@MainActor apply()` reducer** (returns inverses, assigns Lamport order). This is the foundation everything hangs off — build it before any agent code. [elevated from NEXT_STEPS step 5]
- 1.3 World-coord `@Observable CanvasStore` + `Viewport` camera; **hybrid Canvas/culled-views render via NSScrollView/Metal, NOT ScrollView**; per-frame coalescing; `withAnimation` for agent ops, instant for user drags. Fractional-index TEXT `z`. Tombstone snapshots.
- 1.4 Liquid Glass on chrome only; one `GlassEffectContainer`; audit after SDK bump.

**Phase 2 — MCP server + IPC (single live writer)**
- 2.1 FastMCP 3.x server (`mcp-server/`), stdio, `uv`-managed; **expose `apply_canvas_ops(ops=[...])` BATCH tool + read tools; do NOT expose single-node mutators to the agent.** Log to stderr only.
- 2.2 App launches the bundled CPython sidecar via `Process`; `stdout → AsyncStream → @MainActor`; define the `canvas/ops` JSON-RPC notification shape (pin `fastmcp>=3.4,<4`; built-in notifications as fallback).
- 2.3 **Security: bind any app-hosted socket to `127.0.0.1`; per-launch token handshake; destructive tools OFF the `dontAsk` auto-allowlist** (caveat #14).
- 2.4 Register the server with the user's Claude Code (T3 heavy/dev seam).

**Phase 3 — Shared store**
- 3.1 SQLite (WAL, `busy_timeout`), GRDB migrations on Swift; Python reads/writes the same file. Persist on debounce. Cross-writer liveness via the §1.4 socket, not polling.

**Phase 4 — Engine B (T1 live hot path) — the differentiator**
- 4.1 **Define ONE provider-agnostic `CanvasOp` JSON schema; validate streaming structured output on Groq gpt-oss-20B, Cerebras gpt-oss-120B, Haiku 4.5, and on-device guided generation** (caveat #6). [new, gates the router]
- 4.2 **Engine B = a single streaming fast-model call, NO agent loop, NO MCP**: apply each op the instant it parses. Router: mechanical→Groq gpt-oss-20B; real layout→Gemini 3 Flash `minimal` / Cerebras gpt-oss-120B; must-see-keyframes→Haiku 4.5; offline→AFM 3 batched `@Generable`.
- 4.3 **Reproduce/clear the Gemini 3 Flash tools+JSON text-leak bug** before it carries layout (caveat #7).
- 4.4 **Benchmark per-turn latency on real schema + board-state context** to validate the T1 budgets (caveat #5).

**Phase 5 — Engine A (T2 board generation) + conflict layer**
- 5.1 **Claude Agent SDK headless** (pinned fast model, `effort:low`, `maxTurns`/`maxBudgetUsd`, `--bare`, `dontAsk`, pre-approved `mcp__rainy__*`), emitting ONE `apply_canvas_ops` batch per intent; subagents for big boards; stream `AssistantMessage`s to a progress affordance.
- 5.2 **Soft lock + suggestion/ghost layer + autonomy slider + intent labels** (§1.5). Additive=auto, destructive=suggest. Define failure modes (Engine B timeout mid-stream, sidecar crash mid-batch, malformed/oversized op-list).

**Phase 6 — On-device AI + pipeline**
- 6.1 AFM 3 v3 keyframe VLM via image `Attachment` + `OCRTool`, `@Generable SceneDescription` → SQLite. **Benchmark image throughput on M1 + M4** (caveat #9). Escalate hero/ambiguous frames to Claude vision (D13).
- 6.2 Pipeline (yt-dlp → PySceneDetect → ffmpeg keyframes) in the sidecar; evaluate a **`container` machine** for the messy Python deps; **benchmark container vs native ffmpeg keyframe latency** before committing location. 720p cap + analyze-then-evict.
- 6.3 SpeechAnalyzer transcription; Vision OCR; App Intents for "analyze creator / add to canvas".

**Phase 7 — Hardening**
- 7.1 Validate the hardened-runtime entitlement set against current Apple docs; sign + notarize every nested arm64 binary; Developer-ID distribution (caveat #12).
- 7.2 Re-check Codex-Spark API status (recheck monthly; structured-output reliability is the real gate, not just availability).

**Re-scrape triggers:** macOS 27 GM; new Xcode beta; AFM 3 symbol names confirmed against shipping
docs; Codex-Spark public API; `Cordova v. Huneault` merits ruling.

---

## 5. What to change in DECISIONS.md (concrete)

- **D3** — toolchain → Swift 6.4 / macOS 27 SDK (was "latest Xcode beta"; brief's 6.3.2/macOS 28 is wrong).
- **D7 / R7** — Codex-Spark: downgrade from "if available" fallback to **watchlist-only**; not required to ship.
- **D14 + R1-revised** — collapse to **one live writer** (app-spawned sidecar); Claude-Code instance = non-real-time writer via SQLite + authenticated localhost socket; define the animated-vs-committed transactional boundary. **This is the highest-priority decision to finalize.**
- **R8** — confirm the tier table with named June-2026 models (Groq `gpt-oss-20B` replaces deprecated Llama 3.1 8B; add Gemini 3 Flash minimal-thinking and Cerebras gpt-oss-120B; Haiku 4.5 for vision; PCC as privacy middle tier).
- **D10/D11 → D18 (owner decision):** URL download is the **marketed hero** (owner override of the BYO-first recommendation). Keep all caveat-#1 mitigations; obtain counsel pre-launch.
- **New decision** — agent tool surface exposes **`apply_canvas_ops(ops=[...])` batch only**, no single-node mutators (one intent → one op-list).
