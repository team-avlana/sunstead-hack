# WWDC 2026 Developer Tools & Frameworks — Survey for Rainy

_Last updated: 2026-06-24_

Exhaustive, implementation-focused survey of the Apple developer stack as of **WWDC 2026 (keynote June 8, 2026; Platforms State of the Union June 9, 2026)**, scoped to what touches **Rainy** (SwiftUI infinite-canvas app + menu-bar companion + local yt-dlp → PySceneDetect → ffmpeg → VLM pipeline + FastMCP stdio server, targeting macOS 27 "Golden Gate").

This **builds on** (does not duplicate) the sibling docs:
- `macos-27-golden-gate.md` — OS-level facts, Apple-silicon-only, Rosetta sunset, AppKit, toolchain table.
- `liquid-glass-swiftui.md` — full Liquid Glass API surface and HIG.
- `swiftui-macos-app-structure.md`, `menu-bar-app.md` — app skeleton.

Status legend: **[CONFIRMED]** Apple keynote/docs/release notes · **[REPORTED]** consistent across multiple secondary sources · **[RUMORED/UNVERIFIED]** single-source or speculative. Everything macOS 27 / Xcode 27 is **pre-release beta** as of 2026-06-24.

> **⚠️ Two brief/reality discrepancies to resolve in project docs:**
> 1. The Rainy brief says the installed toolchain is **Swift 6.3.2 targeting the macOS 28 SDK**. Public facts say **Xcode 27 beta ships Swift 6.4 + the macOS 27 SDK** [CONFIRMED, Xcode 27 release notes]. There is no public "macOS 28 SDK" in June 2026. Treat the project's local string as either an internal/seed build or a typo; **target the macOS 27 SDK / Swift 6.4**.
> 2. `macos-27-golden-gate.md` §5 lists "Swift 6.4" already — consistent with this doc. (An earlier note of "Swift 6.3.2" should be reconciled to 6.4.)

---

## 0. TL;DR for Rainy's two open questions

**Q: Is near-real-time agent editing of the canvas feasible via Claude Code over MCP, or do we need a local ultra-fast model ("Codex Spark")?**

Both are now first-class, and they compose:
- **Claude Code over our FastMCP stdio server stays the right backbone for agentic, multi-step canvas edits.** MCP is now the *Apple-blessed* extension protocol across the whole stack (Xcode 27 is itself an MCP host; Foundation Models exposes tool-calling; App Intents is the action layer). Round-trip latency to Claude is the limiter for *per-keystroke* feel, not for *operation-level* ("add 12 nodes summarizing these clips") feel.
- **For the genuinely real-time, sub-100 ms loop, you now have an on-device option that did NOT exist before WWDC 2026:** the **Foundation Models `LanguageModel` protocol** with **`MLXLanguageModel`** (Mac GPU) or **`CoreAILanguageModel`** (Neural Engine), or a custom small model via **Core AI**. This is the real "Codex Spark" — a local ultra-fast model — except it's Apple-shipped, runs on-device, and speaks the *same Swift API* as the cloud models. See §4.
- **Recommended split:** local FM/MLX model = the real-time router / cheap structured edits / VLM frame analysis; Claude (via MCP, or via the Anthropic Swift package in-process) = the heavyweight brainstorming agent. The SQLite-WAL store stays the source of truth; both writers go through it.

**Q: Can Apple's Containerization run our Python/Linux pipeline?**

**Yes — and this is the headline find for Rainy.** Apple shipped **`container` 1.0.0 (June 9, 2026)** plus **"container machines"** (WWDC26 session 389): persistent, sub-second-start Linux VMs with **automatic user + working-directory mapping** and per-machine IP. yt-dlp/PySceneDetect/ffmpeg are trivially Linux-friendly; a container machine gives you a clean, reproducible, arm64 Linux toolchain with shared filesystem to `/Users/...`. See §4.4. (Caveat: it's a VM boundary, not free — for the lowest-latency ffmpeg keyframe path you may still prefer a native arm64 ffmpeg on the host.)

---

## 1. Xcode 27

| | |
|---|---|
| Version | **Xcode 27** (Beta 2 live as of 2026-06-24) [CONFIRMED] |
| Bundled Swift | **Swift 6.4** [CONFIRMED] |
| Bundled SDKs | iOS / iPadOS / tvOS / **macOS** / visionOS **27** [CONFIRMED] |
| Runs on | **macOS Tahoe 26.4+**, **Apple silicon only** (no Intel) [CONFIRMED] |
| App size | **~30% smaller** than Xcode 26 [REPORTED, Platforms SOTU] |
| Public release | Expected **September 2026** [REPORTED] |

### 1.1 "Coding Intelligence" — the AI rework (this is the big one)

Apple reframed Xcode's AI from the 2024 "Swift Assist" single-model chat into a **multi-provider, multi-agent, MCP-host architecture**. [CONFIRMED via Apple newsroom + SOTU]

**Model providers integrated out of the box** [CONFIRMED]:
- **Anthropic Claude**, **OpenAI ChatGPT/GPT**, **Google Gemini** — selectable in **Intelligence settings**.
- **Apple's own on-device model** for inline/predictive completion (never leaves the device).
- **"Any provider"** via a new **language-model protocol** (bring-your-own endpoint) and **custom local weights** via the **Core AI** framework (§4.2).
- Note: Apple's *system* models are now built in collaboration with **Google Gemini** [REPORTED] — distinct from the in-IDE Gemini agent option.

**Predictive / inline completion** [CONFIRMED + REPORTED detail]:
- On-device, **multi-line** predictive completion runs on the **Apple Neural Engine**; source code never leaves the machine (unified memory: CPU/GPU/ANE share it).
- The completion model is **Swift/Apple-SDK-specialized, not a general LLM**. Size **~2.2 GB in memory** [REPORTED, single-source — treat as approximate].
- This is the lineage successor to **Swift Assist** (announced WWDC24) — Swift Assist's chat role is now folded into the multi-provider agentic chat; predictive completion is its own on-device path.

**Agentic coding** [CONFIRMED]:
- Interactive **planning**, **multi-turn Q&A**, a **canvas** that renders Markdown with side-by-side code diffs + previews.
- Agents can **write code, build, run/write tests, fix crashes, verify UI in the simulator, localize apps** — a full dev loop in one session.
- **Device Hub** replaces the old Simulator chrome and is the agent's UI-verification surface. [REPORTED]
- **Xcode Cloud** builds up to **2× faster**; iCloud settings sync; per-project themes; customizable toolbar. [REPORTED]

### 1.2 Xcode 27 is an MCP **host** — directly relevant to Rainy's MCP design

[CONFIRMED Apple is MCP host; mechanism REPORTED across multiple sources]

- Xcode 27 ships a binary **`mcpbridge`** that translates **MCP over XPC** (Apple's sandboxed IPC) into Xcode's live process — *not* HTTP/sockets. External agents connect via **JSON-RPC 2.0 over stdio** and get ~**20 structured Xcode capabilities** (diagnostics, symbol info, SwiftUI previews, Swift REPL) instead of scraping compiler text.
- **Agents that can connect:** **Claude Code**, **OpenAI Codex**, **Cursor** — anything that speaks MCP.
- **Agent Client Protocol (ACP):** a separate authorization layer controlling *which* agents may connect at all (distinct from MCP's capability list).
- **Seven Apple-authored "agent skills"** ship with Xcode 27 [REPORTED names]:
  `swiftui-specialist`, `swiftui-whats-new-27`, `uikit-app-modernization`, `test-modernizer`, `audit-xcode-security-settings`, `c-bounds-safety`, `device-interaction`.
  Exportable for use in other agents: `xcrun agent skills export --output-dir ~/Downloads/xcode-skills` — meaning **you can feed Apple's SwiftUI/SwiftUI-27 skill packs into your own Claude Code sessions** working on Rainy.

**Implication for Rainy:** our local Claude Code can drive *both* (a) Rainy's own FastMCP server (canvas + SQLite) and (b) Xcode 27's `mcpbridge` (live diagnostics/previews/REPL) in the same session. MCP is now the universal seam. The stdio transport we already chose is exactly what Xcode and these agents use.

---

## 2. Swift 6.4

**[CONFIRMED]** Released at WWDC 2026; bundled with Xcode 27; **backwards-compatible with Swift 6.x — no breaking changes**. macOS kernel portions are now partly written in Swift [REPORTED].

The Swift 6.3 → 6.4 line is **ergonomics + reach**, not a new concurrency model. The strict-concurrency foundation (6.0) and **Approachable Concurrency** (6.2) are the substance; 6.4 polishes them.

### 2.1 Approachable Concurrency recap (6.2, still the model in 6.4) — adopt this for Rainy

- **Progressive disclosure:** you only reason about as much concurrency as you actually use.
- **Single-threaded-by-default** for app/UI/script targets: code runs on the main actor without explicit `@MainActor` sprinkling (opt-in build setting / default-actor-isolation = MainActor). Cuts false-positive Sendable diagnostics dramatically.
- **`@concurrent`** explicitly marks functions that should hop off the main actor to a background executor — use this for the heavy lifts (frame decode dispatch, MCP I/O fan-out, SQLite writes off the main actor).

### 2.2 Swift 6.4 concurrency convenience additions [REPORTED, SwiftLee/byteiota]

- **Async `defer`** (SE-0493) — `await` in `defer` bodies of async functions. Clean teardown of pipeline subprocesses / temp files.
- **Task cancellation shields** (SE-0504) — `withTaskCancellationShield { }` to protect critical rollback/commit (e.g. finishing a SQLite transaction even if the agent task is cancelled).
- **Warn on ignored throwing `Task`** (SE-0520) — catches silently dropped errors.
- **Typed throwing `Task` initializers** — `Task<String, URLError>` etc.
- **Async `Result`** (SE-0530) — `await Result { try await ... }`.

### 2.3 Swift 6.3+ language items relevant to us [REPORTED]

- **Weak `let`** (SE-0481) — `weak let` for Sendable compliance.
- **Explicitly non-Sendable** (SE-0518) — `~Sendable` to document intentional non-conformance.
- **Iterate noncopyable types** without copy penalty (6.4) — for value-heavy buffers.
- **`anyAppleOS` availability shorthand** — collapses multi-line `#available` blocks to one line. [CONFIRMED, SOTU]
- **Suppressible compiler warnings** + improved diagnostics. [CONFIRMED, SOTU]
- **Reach:** Swift now targets microcontrollers/embedded, servers, **Android**, and the browser/WASM — relevant only if we ever push pipeline pieces server-side.

---

## 3. SwiftUI 2026 (iOS/macOS 27 SDK)

Apple's framing: *not a redesign* — many small limitations removed + real performance wins. [CONFIRMED via "What's New in SwiftUI" WWDC26]

### 3.1 Performance (matters for the infinite canvas)

- **~2× faster layout** [CONFIRMED, SOTU]; rewritten frame scheduling → fewer dropped frames, smoother scroll on iOS **and** macOS. Long/complex lists reported at **120 fps** [REPORTED].
- **`LazyVStack`/`LazyHStack`: size estimation + prefetching** [REPORTED] — directly useful for large canvas/long node lists.
- **Lazy `@State` init:** `@State` is now effectively a macro with lazy initialization for `@Observable` classes; **backported to iOS 17 / macOS 14** [REPORTED].
- **New `SwiftUI Performance` Instrument** in Xcode 27 — debug view updates, slow layout, bottlenecks. [REPORTED]
- **`@ContentBuilder`** — unified result builder; reduces compile-time type-checking blowups; builder contents no longer must conform to `View`. [REPORTED]

### 3.2 Canvas / drawing / text rendering

- **No dedicated "infinite canvas" API shipped** [CONFIRMED-by-absence]. Build it from `Canvas` + `TextRenderer` (custom-drawn node labels) and lazy containers.
- **`ScrollView` gesture/scroll customization is still not fully solved** [REPORTED/UNVERIFIED for 27]. For a true pan/zoom infinite canvas, plan to drop to **AppKit `NSScrollView`** or a custom **Metal/`Canvas`** surface — validate early. (See `macos-27-golden-gate.md` §4 caveat.)
- **AppKit `NSTextSelectionManager`** (new in 27) enables full text selection/drag in **custom views** — useful for editable text nodes on the canvas. (See `macos-27-golden-gate.md` §4.)

### 3.3 Rich text — now native

- **`TextEditor` binds to `AttributedString`** (shipped iOS/macOS 26, present in 27): change the bound state's type and you get rich-text editing — bold/italic/color/links inline. Ideal for Rainy's text nodes / note cards. [CONFIRMED]

### 3.4 Containers, scroll chrome, navigation, documents

- **Reorderable containers:** `.reorderable()` on `ForEach` + `.reorderContainer()` on the parent (List, `LazyVGrid`, watchOS) — drag-reorder in any container. [REPORTED]
- **Swipe actions anywhere:** `.swipeActions` + `.swipeActionsContainer()` on arbitrary views in scroll containers. [REPORTED]
- **Toolbar:** `.visibilityPriority(.high)`, `ToolbarOverflowMenu`, `.topBarPinnedTrailing`, `.toolbarMinimizeBehavior(.onScrollDown, for: .navigationBar)`. [REPORTED]
- **Window state:** `appearsActive` environment value (dim custom chrome when window inactive) — pair with Liquid Glass legibility. [REPORTED]
- **Documents:** new `ReadableDocument`/`ReadableDocument`-style protocols — `WritableDocument`, `DocumentWriter`, `ReadableDocument`, `DocumentReader`, `DocumentCreationSource`; async read/write + progress; document is a reference type marked `@Observable`. Replaces `FileDocument`/`ReferenceFileDocument`. Relevant if a Rainy "project/canvas" becomes a document. [REPORTED]
- **`AsyncImage`:** respects HTTP cache headers by default; `URLRequest` initializers; `asyncImageURLSession(_:)`. Useful for thumbnail/keyframe loading. [REPORTED]
- **Navigation:** `CrossFadeNavigationTransition`, `AnyNavigationTransition` eraser. [REPORTED]

### 3.5 Liquid Glass in 2026 — beyond `liquid-glass-swiftui.md`

- **API surface unchanged from 26** (`glassEffect`/`Glass`/`GlassEffectContainer`/`glassEffectID`/`glassEffectUnion`/`backgroundExtensionEffect`). See `liquid-glass-swiftui.md` for the full surface — do not re-implement here.
- **New in the 27 SDK posture:** Liquid Glass adoption is now **forced on recompile** — the opt-out is being removed. [REPORTED, SOTU: "Forced migration; opt-out support removed."] Audit all Rainy chrome after the SDK bump.
- **Golden Gate runtime** adds the user **translucency/tint slider** + uniform concentric corners (`.containerConcentric`). Test chrome legibility across the slider range. (Details: `macos-27-golden-gate.md` §3, `liquid-glass-swiftui.md` §9.)
- **Rainy rule unchanged:** glass on floating chrome/palettes/inspector only — **never on canvas content or individual nodes**; wrap chrome in as few `GlassEffectContainer`s as possible.

---

## 4. New / updated frameworks that touch Rainy

### 4.1 Foundation Models framework — **v3 / AFM 3** (the on-device VLM path)

**[CONFIRMED core; some figures REPORTED]** This is the framework Rainy's brief calls "on-device Apple Foundation Models v3." WWDC 2026 turned it from an Apple-only on-device API into a **provider-agnostic Swift LLM layer**.

**The on-device model — AFM 3:**
- Rebuilt; better reasoning + tool calling; refined guardrails (fewer false positives).
- **Mixture-of-experts:** **~20 B parameters** resident in flash; **~1–4 B active** at inference depending on complexity. **~45.6%** preference improvement over the 2025 baseline. [REPORTED]
- **Vision / multimodal input** — pass images alongside text. **Image input requires "AFM 3 Core Advanced" (the 20 B sparse model)** → **iPhone 15 Pro+, latest iPad Pro, and Mac (Apple silicon)**. [REPORTED] This is exactly Rainy's keyframe-VLM use case running fully on-device.

```swift
let session = LanguageModelSession()
let response = try await session.respond {
    "Describe the scene and list on-screen text."
    Attachment(nsImage)            // NSImage / CGImage / CVPixelBuffer / file URL all accepted
}
```
- New inspection APIs (from 26.4): `model.contextSize`, `model.tokenCount(for:)`.
- **Structured output** + **tool calling**, including Apple-provided **system tools**: **`OCRTool`**, **`BarcodeReaderTool`** (Vision-backed, on-device), and a **Spotlight-powered search tool** for local RAG. Rainy can let the model call OCR directly on keyframes.

**The `LanguageModel` protocol — one API, many backends:**
- `LanguageModelSession(model:)` accepts any conforming model. Apple ships/blesses:
  - **on-device system model** (AFM 3),
  - **`PrivateCloudComputeLanguageModel`** — 32k context, configurable `reasoningLevel` (`.light`/`.deep`), **free for apps with <2M first-time downloads**, no API keys,
  - **`CoreAILanguageModel`** — run custom weights on the **Neural Engine** (open source),
  - **`MLXLanguageModel`** — run open-source Hugging Face MLX models on the **Mac GPU** (open source),
  - **official Anthropic Swift package (Claude)** and **official Google Swift package (Gemini)** as server backends.

```swift
import AnthropicLanguageModel   // Apple-published-adjacent Anthropic Swift package
let claude = AnthropicLanguageModel(apiKey: .keychain)   // OAuth + Keychain; never bake keys in the binary
let session = LanguageModelSession(model: claude)
```

**This is decisive for Rainy's router:** you can write the canvas-editing logic once against `LanguageModelSession` and swap among (a) AFM 3 on-device, (b) an MLX small model for the real-time loop, (c) Claude for heavy brainstorming — **same Swift call site**, with unified token/usage accounting (`response.usage.input.cachedTokenCount`, `.output.reasoningTokenCount`).

**Dynamic Profiles — built for multi-agent/mode-switching apps** (i.e. Rainy's live canvas agent):
```swift
struct CanvasProfile: LanguageModelSession.DynamicProfile {
    let state: CanvasStates
    var body: some DynamicProfile {
        switch state.mode {
        case .analyzeFrames:
            Profile { Instructions { "Analyze keyframes…" }; OCRTool(); SwitchModeTool(states: state) }
        case .brainstorm:
            Profile { Instructions { "Brainstorm canvas nodes…" }; AddNodeTool() }
                .model(state.privateCloudCompute).reasoningLevel(.deep)
        }
    }
}
```
Switches instructions/tools/model mid-session while preserving history — maps cleanly onto "analyze clip → brainstorm nodes" flows.

**Also shipped:**
- **`fm` CLI** (macOS 27): `fm chat`, pipe into shell scripts for summarize/extract — handy for our Python pipeline glue without writing Swift.
- **Foundation Models Python SDK** (`import apple_fm_sdk as fm`) — call the on-device model **from Python**, i.e. directly inside Rainy's existing pipeline. `SystemLanguageModel()`, `LanguageModelSession`, async `respond(prompt=…)`.
- **Foundation Models is going open source** (full framework + a "utilities" package: Skill API, profile modifiers, Chat-Completions interface) — **runs on Linux servers anywhere Swift runs**. Open-source release targeted **summer 2026**.
- **Evaluations framework** — measure feature quality/accuracy when tuning prompts.

> Availability flags: on-device vision, Dynamic Profiles, system tools, `fm` CLI, Python SDK = **macOS 27**; context/token APIs = **26.4+**; PCC free tier = watchOS 27+/all. All beta.

### 4.2 Core AI (new framework) — "best way to run models on device"

**[CONFIRMED]** New framework for running **custom on-device models**, Apple-silicon-only:
- **Ahead-of-time compilation**, dedicated **Instruments**, **Python tools to convert PyTorch → Apple silicon**, optimized for unified memory + Neural Engine.
- Powers Siri; surfaced to devs as `CoreAILanguageModel` inside Foundation Models (§4.1).
- **Rainy fit:** if you want a bespoke ultra-fast canvas/router model (the "Codex Spark" idea), Core AI is the path to convert and run your own small PyTorch model on the ANE — zero per-token cost, no server. WWDC26 sessions 324 ("Meet Core AI") and 326 ("Integrate on-device AI models using Core AI").

### 4.3 MLX + MLX Swift updates

**[REPORTED]**
- **MLX now supports Metal 4** and can **scale training across multiple Macs via RDMA over Thunderbolt**.
- **First-class in Apple's AI stack:** `MLXLanguageModel` lets you pull **any Hugging Face MLX-community model** and run it through the **same Foundation Models `LanguageModelSession` API**, on the Mac **GPU**.
- **Rainy fit:** the most pragmatic "local ultra-fast model" for the real-time canvas loop today — pick a small instruct model from HF MLX, wrap in `MLXLanguageModel`, route real-time edits to it; escalate to Claude for depth.

### 4.4 Containerization / `container` / **container machines** — run the Python pipeline

**[CONFIRMED `container` 1.0.0 on 2026-06-09; machines = WWDC26 session 389]**
- **`Containerization`** (open-source Swift package) + **`container`** CLI: run **Linux OCI containers** as **lightweight VMs** on Apple silicon. **Sub-second start**, per-container **dedicated IP** (no port-forwarding), minimal root FS + lightweight init.
- **Container machines (new in `container` 1.0):** **persistent** Linux environments (stateful across stop/start) with **automatic username + working-directory mapping** to your Mac and **shared filesystem** — `pwd` inside the machine is your `/Users/you/...`, no copying.
  ```bash
  container machine create --name rainy-pipe --set-default ubuntu
  container machine run -- bash -lc 'yt-dlp --version && ffmpeg -version'
  container machine list           # shows IP + resources
  ```
- **Platform:** built on macOS 26+ virtualization/networking; runs on macOS 27. Apple-silicon-only.
- **Rainy fit:** ideal reproducible home for **yt-dlp + PySceneDetect + ffmpeg** — clean arm64 Linux, persistent, shared FS to the app's data dir, isolated network. **Caveat:** it's still a VM boundary (some I/O + GPU-encode overhead). For the *hot* ffmpeg keyframe-extraction path you may prefer a **native arm64 `ffmpeg`/`VideoToolbox` on the host** (§4.6) and use the container machine for the heavier/messier Python deps. Decide per-stage; you are not forced all-in.

### 4.5 App Intents, "Siri takes actions," Visual Intelligence

**[CONFIRMED direction; REPORTED specifics]** This is Apple's "agent / takes-actions" layer.
- **App Intents is now the mandatory action surface; SiriKit deprecated.** Adopt **intent/entity schemas** so Siri/Spotlight can invoke Rainy actions via natural language with little code.
- **Actions API** expanded for third-party apps; Siri gains **persistent memory + cross-app task execution**.
- **View Annotations API** — map your views to entities so the assistant has **on-screen awareness** and users can act on what's visible. Conceptually adjacent to a canvas agent.
- **App Intents Testing framework** — validate Siri/Shortcuts/Spotlight via real system paths (no UI automation).
- **Visual Intelligence API opens to third parties** — same camera/onscreen recognition as Apple's Camera app, surfaced via App Intents. Lower priority for Rainy (we already analyze frames with VLMs), but a path to "find canvas content matching what's onscreen."
- **Rainy fit:** expose key canvas operations as App Intents → free Spotlight/Siri/Shortcuts entry points, and a *second* (non-MCP) agent seam. Lower priority than the MCP/FM router.

### 4.6 Media / video — efficient frame extraction

**[REPORTED — no headline 2026 frame-reader API surfaced; existing stack is the answer]**
- **No new "frame reader" API was announced for macOS 27** in the sources reviewed. Use the established, hardware-accelerated path:
  - **`AVAssetImageGenerator`** for keyframe/thumbnail extraction (`generateCGImagesAsynchronously(forTimes:)`), `requestedTimeToleranceBefore/After = .zero` for exact frames.
  - **`VTFrameProcessor`** (from 2025) for GPU frame ops — e.g. **low-latency frame interpolation**, super-res, optical-flow style passes; useful if scene-detection wants synthesized in-between frames.
  - **VideoToolbox** for hardware decode (ProRes/H.264/HEVC), `AVAssetReader` for sample streaming.
- **Apple Immersive Video / spatial** got the 2026 attention (sessions 338 "live production tools," 287 visionOS 27, **Spatial Preview framework** to push 3D/immersive content from a Mac app into Vision Pro). **Out of scope** for Rainy's 2D creator pipeline unless we add spatial export.
- **Rainy fit:** ship a **native arm64 `ffmpeg`** for the bulk keyframe extraction (you already use it); consider `AVAssetImageGenerator`/VideoToolbox for tighter, sandbox-friendly, hardware-accelerated in-app extraction where you don't want a bundled binary.

---

## 5. Distribution / build / signing changes

**[CONFIRMED unless noted]**
- **Apple-silicon-only is now real at the store level:** developers can **ship arm64-only binaries on the Mac App Store**; Intel-Mac support is deprecated/complete for new tooling. Build **arm64-native** — there is no Rosetta runway past macOS 27 (full Rosetta ends after 27; see `macos-27-golden-gate.md` §2). [CONFIRMED direction]
- **Liquid Glass adoption forced on recompile** against the 26/27 SDK — opt-out removed. Audit chrome (toolbars/buttons/tab bars auto-restyle). [REPORTED, SOTU]
- **Notarization / hardened runtime / entitlements:** **no NEW WWDC-2026 requirement surfaced** in the sources — existing Developer ID + notarization + hardened-runtime rules stand. For Rainy specifically the **load-bearing items are unchanged but critical**:
  - Bundling Python/yt-dlp/ffmpeg/PySceneDetect requires the hardened-runtime entitlement **`com.apple.security.cs.allow-jit`** and/or **`com.apple.security.cs.allow-unsigned-executable-memory`** if the interpreter JITs, plus **`com.apple.security.cs.disable-library-validation`** to load third-party/unsigned `.so`/dylibs that pip pulls in.
  - **Every** bundled Mach-O (interpreter, ffmpeg, native wheels' `.so`) must be **signed and notarized**; notarization staples the app, not loose binaries — sign nested binaries first, then the app.
  - If sandboxed (Mac App Store), spawning arbitrary subprocesses (yt-dlp/ffmpeg) is heavily constrained — a **Developer-ID (outside-MAS) distribution** is the pragmatic route for a tool that shells out to a Python pipeline. (Or move the pipeline into a **container machine**, §4.4, which sidesteps in-bundle interpreter signing entirely.)
  - All bundled binaries must be **arm64** (no x86 slices) for macOS 27.
  > ⚠️ The specific entitlement set above is **standard Apple guidance (pre-2026), not a WWDC26 change** — verify against current `developer.apple.com/documentation/security` before shipping. Flagged as the one area where Rainy must do its own validation.

---

## 6. Confirmed vs uncertain — quick reference

**[CONFIRMED]** Xcode 27 + Swift 6.4 + macOS 27 SDK, Apple-silicon-only, Tahoe 26.4+ host; Xcode is an MCP host; multi-provider Coding Intelligence (Claude/ChatGPT/Gemini/on-device); on-device predictive completion on ANE; Foundation Models v3 with image input, `LanguageModel` protocol, PCC free tier, Dynamic Profiles, OCR/Barcode/Spotlight tools, `fm` CLI, Python SDK, going open source (summer 2026); Core AI framework; MLX → Metal 4 + multi-Mac RDMA + `MLXLanguageModel`; `container` 1.0.0 + container machines; App Intents mandatory / SiriKit deprecated + Visual Intelligence API to third parties; arm64-only App Store binaries; forced Liquid Glass adoption.

**[REPORTED — corroborated, verify before relying]** `mcpbridge`/XPC mechanics and the "20 capabilities"; the seven agent-skill names + `xcrun agent skills export`; ~2.2 GB completion model; AFM 3 20B/1–4B MoE + 45.6% figure; "AFM 3 Core Advanced" device gating; Device Hub; 2× layout / 120 fps; reorderable/swipe/toolbar API names; document protocol names.

**[UNVERIFIED / WATCH]** `ScrollView` gesture customization still unsolved in 27; exact macOS 27 GM date; any net-new notarization/entitlement requirement (none found — assume status quo, verify); the project's local "Swift 6.3.2 / macOS 28 SDK" string vs public "Swift 6.4 / macOS 27 SDK".

---

## 7. Concrete recommendations for Rainy

1. **Keep MCP as the backbone.** It's now Apple's universal agent seam; our FastMCP stdio server is aligned with how Xcode 27 + Claude Code + Codex all talk. Claude Code over MCP handles operation-level agentic canvas edits well.
2. **Add an on-device fast lane** via Foundation Models `LanguageModelSession` + **`MLXLanguageModel`** (or **Core AI** custom weights) for the sub-100 ms real-time loop and cheap structured edits. This *is* the "Codex Spark" — no third party needed. Write the editing logic once against `LanguageModelSession`; route by latency/complexity.
3. **Use AFM 3 on-device for keyframe VLM analysis** (image `Attachment` + `OCRTool`) — privacy-preserving, zero per-token cost; fall back to Claude vision only for hard frames.
4. **Run the Python pipeline in a persistent `container` machine** for a clean reproducible arm64 Linux toolchain with shared FS — but keep the hot ffmpeg keyframe path native (arm64 ffmpeg / VideoToolbox) if latency-critical.
5. **Distribute outside the Mac App Store via Developer ID** so the bundled interpreter/ffmpeg/yt-dlp subprocess model works; sign+notarize every nested arm64 binary; set the JIT/library-validation entitlements. (Validate this set against current Apple docs — the one place to double-check.)
6. **Adopt Approachable Concurrency** (single-threaded-by-default + `@concurrent` for heavy lifts) and pull Apple's `swiftui-whats-new-27` agent skill into Claude Code sessions on this repo.
7. **Audit chrome after the SDK bump** (forced Liquid Glass); keep glass off canvas content; test across the Golden Gate translucency slider.

---

## Sources

**Apple (primary):**
- Apple Newsroom — Apple aids app development with new intelligence frameworks and advanced tools — https://www.apple.com/newsroom/2026/06/apple-aids-app-development-with-new-intelligence-frameworks-and-advanced-tools/
- Xcode 27 release notes — https://developer.apple.com/documentation/xcode-release-notes/xcode-27-release-notes
- WWDC26 241 — What's new in the Foundation Models framework — https://developer.apple.com/videos/play/wwdc2026/241/
- WWDC26 324 — Meet Core AI — https://developer.apple.com/videos/play/wwdc2026/324/
- WWDC26 326 — Integrate on-device AI models into your app using Core AI — https://developer.apple.com/videos/play/wwdc2026/326/
- WWDC26 389 — Discover container machines — https://developer.apple.com/videos/play/wwdc2026/389/
- WWDC25 346 — Meet Containerization — https://developer.apple.com/videos/play/wwdc2025/346/
- WWDC26 338 — Build live production tools for Apple Immersive Video — https://developer.apple.com/videos/play/wwdc2026/338/
- WWDC26 287 — Build next-generation experiences with visionOS 27 — https://developer.apple.com/videos/play/wwdc2026/287/
- WWDC26 Apple Intelligence guide — https://developer.apple.com/wwdc26/guides/apple-intelligence/
- WWDC26 macOS guide — https://developer.apple.com/wwdc26/guides/macos/
- What's New — AI & ML — https://developer.apple.com/machine-learning/whats-new/
- What's New — SwiftUI — https://developer.apple.com/swiftui/whats-new/
- App Intents — https://developer.apple.com/documentation/appintents
- VideoToolbox — https://developer.apple.com/documentation/videotoolbox
- apple/container — https://github.com/apple/container
- apple/containerization — https://github.com/apple/containerization
- macOS 27 beta release — https://developer.apple.com/news/releases/?id=06082026d
- Swift 6.2 released — https://www.swift.org/blog/swift-6.2-released/
- Adopting strict concurrency in Swift 6 — https://developer.apple.com/documentation/swift/adoptingswift6

**Secondary / dev coverage:**
- MacRumors — Apple Outlines Major AI and Developer Tool Updates (Platforms SOTU) — https://www.macrumors.com/2026/06/09/apple-outlines-major-ai-and-developer-tool-updates/
- InfoQ — Apple Launches Core AI — https://www.infoq.com/news/2026/06/apple-core-ai-wwdc/
- byteiota — Xcode 27 Agentic Coding: MCP, On-Device AI, Agent Skills — https://byteiota.com/xcode-27-agentic-coding-mcp-guide/
- byteiota — Xcode 27 AI Agents multi-model guide — https://byteiota.com/xcode-27-ai-agents-multi-model-guide-for-ios-devs/
- byteiota — Apple Foundation Models WWDC 2026: Multimodal + Python SDK — https://byteiota.com/apple-foundation-models-wwdc-2026-multimodal-python-sdk/
- byteiota — Containerization: Linux Containers Without Docker — https://byteiota.com/apples-containerization-framework-linux-containers-without-docker/
- byteiota — Swift 6.4 at WWDC 2026 — https://byteiota.com/swift-64-wwdc-2026-upgrade/
- Codex KB — Xcode 27 + Codex CLI MCP bridge — https://codex.danielvaughan.com/2026/06/11/xcode-27-codex-cli-mcp-bridge-apple-agentic-coding-ios-macos-development/
- DEV (arshtechpro) — Xcode 27 ships with Apple's own agent skills — https://dev.to/arshtechpro/wwdc-2026-xcode-27-ships-with-apples-own-agent-skills-what-they-are-and-how-to-use-them-3g2
- DEV (arshtechpro) — Foundation Models opened to any LLM provider — https://dev.to/arshtechpro/wwdc-2026-apple-just-opened-the-foundation-models-framework-to-any-llm-provider-5ejn
- DEV (arshtechpro) — What's New in SwiftUI: A Developer's Breakdown — https://dev.to/arshtechpro/wwdc26-whats-new-in-swiftui-a-developers-breakdown-1333
- BleepingSwift — Export & Use Xcode 27's Agent Skills in Claude Code — https://bleepingswift.com/blog/xcode-27-agent-skills-claude-code
- SwiftLee — Swift 6.4: What's New in Concurrency — https://www.avanderlee.com/concurrency/swift-6-4-whats-new-in-concurrency/
- SwiftLee — Approachable Concurrency in Swift 6.2 — https://www.avanderlee.com/concurrency/approachable-concurrency-in-swift-6-2-a-clear-guide/
- SwiftLee — @concurrent explained — https://www.avanderlee.com/concurrency/concurrent-explained-with-code-examples/
- Atelier Socle — Swift 6.3 preview — https://www.atelier-socle.com/en/articles/swift-6-3-preview
- Medium (Varun Nuthalapati) — MLX first-class in Apple's AI stack — https://medium.com/@nuthalapativarun/mlx-is-now-a-first-class-citizen-in-apples-ai-stack-run-any-hugging-face-model-through-foundation-9dfb8dad2191
- andrew.ooo — Core AI vs Foundation Models vs MLX — https://andrew.ooo/answers/apple-core-ai-vs-foundation-models-vs-mlx-ios-27-framework-june-2026/
- TechTimes — Xcode 27 on-device completion uses Neural Engine — https://www.techtimes.com/articles/318045/20260609/xcode-27-device-ai-code-completion-uses-neural-engine-skips-cloud-entirely.htm
- TechTimes — WWDC 2026 Day 3: Xcode 27 Neural Engine — https://www.techtimes.com/articles/318110/20260610/wwdc-2026-day-3-xcode-27-neural-engine-completes-code-without-sending-source-any-server.htm
- Matthew Cassinelli — WWDC26 App Intents & Siri AI special presentation — https://matthewcassinelli.com/wwdc26-app-intents-siri-ai-inside-apple-intelligence-special-presentation/
- Bitrise — WWDC26 under-the-radar for iOS devs — https://bitrise.io/blog/post/wwdc26-under-the-radar
- Michael Tsai — Xcode 27 Announced — https://mjtsai.com/blog/2026/06/09/xcode-27-announced/
- Michael Tsai — Swift 6.2: Approachable Concurrency — https://mjtsai.com/blog/2025/11/03/swift-6-2-approachable-concurrency/
