# Foundation Models v3 as Rainy's Agent Driver — Real-Time Canvas + Scene Analysis Feasibility

_Last updated: 2026-06-24_

Decision-support doc. Answers: **can on-device Apple Foundation Models (AFM 3) drive Rainy's infinite canvas in near-real-time, AND be the workhorse for the video scene-analysis pipeline — or only one of the two, and where must a cloud model take over?**

This builds on (does not repeat) the API/symbol reference in [`foundation-models-v3.md`](./foundation-models-v3.md). Read that for the `LanguageModelSession` / `@Generable` / `Tool` / `Attachment` surface. This doc is about **latency, throughput, reasoning quality, and the routing verdict** for two specific workloads. It refines project decisions **R7/R8** (real-time routing) and **D13** (VLM routing) in `docs/DECISIONS.md`.

> **Confidence flags.** AFM 3 shipped at WWDC 2026 (June 8). Architecture facts are **confirmed** from Apple ML Research + the 2025 tech report (arXiv 2507.13575). Per-token throughput **for the Apple model specifically on Mac is NOT published by Apple** — Apple's only first-party number is iPhone-class (~30 tok/s). Mac throughput here is **inferred** from comparable sparse/small models under MLX, and is marked as such. Exact context-window value is **reported-but-inconsistent across sources** (4,096 vs 8,192). Treat all tok/s figures as order-of-magnitude planning numbers, not contractual.

---

## 0. TL;DR verdict

| Workload | On-device AFM 3 viable? | Verdict |
|---|---|---|
| **(ii) Video scene analysis** (per-keyframe VLM description, tagging, OCR) | **YES — primary path** | On-device AFM 3 Core Advanced with image-in-prompt + guided generation is the right default. Free, private, offline, batchable. Cloud (Claude vision) only for "hero"/hard frames. Confirms **D13**. |
| **(i) Real-time canvas agent** (tight tool-calling loop, live layout/brainstorm) | **PARTIALLY — offline/privacy fallback only, NOT the hot path** | On-device can emit canvas-op batches via guided generation fast enough for a *responsive* feel, but its **reasoning quality and 4K context** are too weak to be the *brainstorming brain* driving a rich canvas. Use it as the **offline/private degraded tier**. The interactive hero path still wants a fast cloud model (Groq/Cerebras small, Haiku) or Claude Code over MCP. Confirms **R8**. |

**One-liner:** AFM 3 is a great *scene-analysis workhorse* and a *serviceable offline agent fallback*, but it is **not** a replacement for a fast cloud model on the real-time brainstorming hot path. You need both — exactly the tiered router already sketched in R8. A local ultra-fast model ("Codex Spark"-class) is **not required** for viability (on-device covers the offline floor; Groq/Cerebras cover the fast cloud path), but would be the ideal hot-path driver *if/when* it gets a public API (R7: still research-preview, no API).

---

## 1. The two workloads, precisely

Rainy has two AI loops with very different shapes:

1. **Scene-analysis pipeline (throughput-bound, batch, offline-friendly).** Per video: yt-dlp → PySceneDetect → ffmpeg keyframes → VLM describes/tags each keyframe → write to SQLite. Dozens to hundreds of frames per video. Each call is **image-in + small structured-out**. Latency per frame matters less than aggregate throughput and cost. Privacy/offline is a feature.

2. **Real-time canvas agent (latency-bound, interactive, tool-calling).** The hero loop: an agent reads app state over MCP and emits a stream of canvas mutations (`add_node`, `move_node`, `connect`, group, label) that animate live on the SwiftUI canvas. Success = the canvas feels *alive* and the *ideas/layout are good*. This needs (a) low TTFT so the first node appears fast, (b) a tight, reliable tool-calling loop, and (c) genuine reasoning to produce a non-trivial brainstorm.

These map to the two verdicts above. The rest of this doc is the evidence.

---

## 2. AFM 3 on-device: the model you actually get

Two on-device models ship in AFM 3 (confirmed, Apple ML Research):

- **AFM 3 Core** — 3B **dense**. The universal on-device model; runs anywhere Apple Intelligence runs.
- **AFM 3 Core Advanced** — **20B sparse**, activating **1–4B params per request** via **Instruction-Following Pruning (IFP)**. Full 20B sits in **NAND flash**; only selected experts load into DRAM. "Prefill-lock": experts are chosen/locked during prefill, so there's **no mid-generation storage I/O** — DRAM bandwidth is freed entirely for decode. Natively multimodal (text + image + audio).

**Device gate (reported, Oflight/MacStories):** Core Advanced requires **≥12 GB RAM** — **iPhone 17 Pro/Air, iPad M4+, Mac M3+, Vision Pro M5**. **Rainy targets macOS 27 on Apple Silicon Macs (M3+), so Core Advanced is in-scope** and is the model Rainy should assume for both workloads. On older Macs you fall back to AFM 3 Core (3B). `SystemLanguageModel.default` picks the best available; gate on `.availability` (see ref doc §2).

**Quantization / memory (confirmed, tech report):** 2-bit QAT weights, 4-bit embedding table, **8-bit KV cache**, KV cache **−37.5%** via cross-block cache sharing, TTFT also cut ~37.5% via prefill bypass. LoRA rank-32 adapters supported.

---

## 3. (a) Inference latency / throughput on Apple Silicon

**First-party number (confirmed, Apple):** ~**30 tokens/sec** decode and **~0.6 ms/prompt-token TTFT** — but this is the **iPhone 15 Pro / 17 Pro** figure for the *3B-class* model. Apple has **not** published a Mac tok/s number for AFM specifically.

**Mac extrapolation (INFERRED, from comparable models under MLX):**
- Small/active-param-light sparse models behave like their *active* size, not total. Core Advanced activates **1–4B**, so it decodes like a ~3B model, not a 20B one.
- Reference points (reported, llmcheck/modelpiper/yage.ai): Qwen3.5 **35B-A3B** (3B active sparse, the closest public analog) hits **64–92 tok/s** on M4 Max, and **~130 tok/s** under MLX on M4 Max (128 GB). 8B dense ≈ **25+ tok/s** on M4.
- Apple's models run on the **Neural Engine / ANE** with an OS-level optimized runtime (not user MLX), with the IFP prefill-lock removing I/O stalls. So a **conservative planning range for AFM 3 Core Advanced on M3/M4 is ~40–90 tok/s decode**, with **prefill 2–3× faster than decode** and prefill on M5 ~35–40% faster than M4.

**TTFT scaling with prompt size:** TTFT is dominated by prefill = O(prompt tokens) at ~0.6 ms/token on the small model. A 1K-token prompt ⇒ ~0.6 s prefill on iPhone-class; Macs are faster. **Implication for Rainy:** keep the canvas system prompt + state context **small** (a few hundred tokens of distilled app state, not raw transcripts) to keep first-node latency sub-second.

**Can it sustain a tight tool-calling loop?** Yes mechanically — but each loop turn pays prefill (re-encode of the growing transcript) + decode of the tool call. At ~50 tok/s decode and small prompts, a single tool-call emission (~30–80 tokens of JSON) is **~0.6–1.6 s**. A loop of N serial tool calls is **N × that** plus your `call()` execution. **This is fine for a "watch it think" cadence (1–2 ops/sec) but NOT for hundreds of ops/sec.** The fix is to **batch ops** (see §5), not to make the loop tighter.

---

## 4. (b) On-device tool calling — latency & reliability

**Confirmed (Apple ML Research + framework docs):**
- The framework **runs the call graph for you** — "potentially complex call graphs of **parallel and serial** tool calls." You define `Tool` types; the model emits calls; the framework executes and feeds results back until done.
- The model is **post-trained on tool-use data**; Apple explicitly calls the 2026 model **"better at logic and tool calling."** Constrained decoding **prevents hallucinated tool names** (the model can only emit valid tool identifiers/arg schemas).
- **Dynamic Profiles** (`LanguageModelSession.DynamicProfile`, beta) let you switch the active tool set / instructions / reasoning level *mid-session* — the intended primitive for agentic flows.

**Can it stream/emit multiple tool calls?** Yes — parallel tool calls are supported, and `streamResponse` surfaces partial output as it generates. Reliability is good *for shallow graphs with few, well-described tools*. **Caveat (reported, Drobinin field report):** real apps see brittleness vs. demos — long tool lists, ambiguous descriptions, and large arg schemas degrade reliability on the small model. **Design rule for Rainy:** keep the canvas tool surface **small and unambiguous** (≤~6 tools), prefer **one batched `apply_ops` tool** over many fine-grained ones, and validate/clamp args app-side.

**Latency reality:** every tool round-trip is a fresh generate. For the canvas, **don't make the model drive each node via a separate tool call** — that's where on-device falls down on a rich layout. Have it emit a **batch** (next section).

---

## 5. (c) Guided generation / structured output — fast enough for a canvas-op batch?

This is the **strongest argument for on-device** and the mechanism that makes the canvas path workable.

**Confirmed (Apple, tech report, WWDC):**
- `@Generable` + `@Guide` ⇒ the OS daemon does **constrained decoding** so output is **guaranteed schema-valid** — no JSON parsing, no malformed output to retry.
- The daemon uses **constrained + speculative decoding** that **speeds up inference** — guided generation is **faster than free-form** because the output space is restricted (fewer wasted tokens, speculative acceptance). Apple: "guided generation actually improves performance by constraining the output space."
- Streaming structured output yields `T.PartiallyGenerated` (every field optional, filled progressively) — perfect for **animating ops as they decode**.

**Design for Rainy — emit a batch of canvas ops in one guided call:**

```swift
@Generable
struct CanvasOpBatch {
    @Guide(description: "Ordered canvas mutations to apply this turn")
    let ops: [CanvasOp]
}

@Generable
struct CanvasOp {
    @Guide(.anyOf(["addNode","moveNode","connect","group","label"]))
    let kind: String
    @Guide(description: "Target/new node id (stable, app-assigned ok)")
    let nodeId: String
    @Guide(description: "World-coord x") let x: Double
    @Guide(description: "World-coord y") let y: Double
    @Guide(description: "Short label / title") let text: String
    @Guide(description: "For connect: source node id") let fromId: String?
    @Guide(description: "For connect: target node id") let toId: String?
}

// Stream the batch so the canvas animates as ops decode in.
let stream = try await session.streamResponse(
    generating: CanvasOpBatch.self,
    includeSchemaInPrompt: false,
    options: GenerationOptions(temperature: 0.4)
) { "Lay out these 8 video themes as a mind-map on the canvas. Group by topic." }

for try await partial in stream {
    // partial.ops is [CanvasOp.PartiallyGenerated]; apply complete ops on @MainActor,
    // coalesced per frame in withAnimation (see canvas/infinite-canvas-swiftui.md, R4).
    applyReadyOps(partial.ops)
}
```

**Throughput math (INFERRED):** a 10-op batch is roughly 10 × ~15 tokens ≈ 150 output tokens. At ~50 tok/s that's **~3 s for 10 ops**, with the **first ops appearing in ~0.3–0.6 s** via streaming. So you get **~3–5 ops/sec sustained**, first node sub-second. That's a **convincing "AI is drawing live" cadence** for an offline/private session — but it's the *generation* that's fast; the *quality of the layout/ideas* is the real bottleneck (§6). Guided generation is **not** the limiting factor — reasoning is.

**Verdict on (c):** structured output speed is **a strength, not a blocker.** On-device can emit canvas-op batches fast enough to feel live. Always use **one batched guided-generation call per turn**, streamed — never one-tool-call-per-node.

---

## 6. (d) Context window + reasoning quality for layout/brainstorm

**Context window (reported, inconsistent):** on-device is **4,096 tokens** (9to5Mac, WisGate) — some 2025-era sources say 8,192, and the multimodal *training* seq-len is 16K, but the **shipping on-device generation budget is small (≈4K)**. PCC is **32K**. **This is the decisive constraint for the canvas agent.** A live brainstorm wants: current canvas state (could be dozens of nodes), recent video analyses, user intent, tool schemas. That blows past 4K fast. You must **aggressively summarize app state** before each on-device turn, or the model can't see enough to brainstorm well.

**Reasoning quality (confirmed, Apple human-eval):** AFM 3 Core is preferred **45.6% vs 23.3%** over the 2025 on-device baseline — a real generational jump, and "better at logic and tool calling." On-device benchmarks (tech report): **67.85 MMLU, 74.91 MGSM** — solid for a 3B-active model, competitive with Qwen-2.5-3B and *favorable* vs larger small models. **But:** these are *small-model* numbers. For an **open-ended, multi-entity layout/brainstorm** ("organize 40 clips into a thematic mind-map with sensible groupings and edges"), a 3-4B-active model with 4K context will produce **shallower, less coherent structure** than a frontier or even a fast mid cloud model.

**Comparison to a cloud fast model (the brainstorm task):**

| | AFM 3 on-device (Core Advanced) | Fast cloud (Groq/Cerebras small, Haiku 4.5) | Claude Code over MCP (heavy) |
|---|---|---|---|
| Context | ~4K (must summarize hard) | 100K+ | 200K+ |
| Reasoning depth for layout | Adequate for simple maps; degrades with scale/ambiguity | Good; handles 40+ nodes, themes | Best; multi-step planning |
| Tool/op-batch throughput | ~40–90 tok/s, sub-s TTFT | 900–1000+ tok/s (Groq/Cerebras) | slower TTFT, heavier turns |
| Privacy/offline | Total (local) | No | No |
| Cost | Free | Cheap | Higher |

**Net:** on-device wins on **latency-to-first-token, privacy, cost, offline**; loses on **context and reasoning depth** — which are exactly what a *good* brainstorm needs. So on-device is the **offline/private floor**, not the hero brain. For the hero path, R8's tiering (Groq/Cerebras hot path, Haiku for reasoning edits, Claude Code for heavy multi-step) is correct. **PCC (`PrivateCloudComputeLanguageModel`, 32K + reasoning, no keys, free under quota) is an attractive middle tier** — same FM API, much better context/reasoning, still privacy-preserving — worth using as the "good-but-still-Apple-private" canvas tier between on-device and third-party cloud.

---

## 7. (e) Image-in-prompt throughput for scene analysis

**Confirmed (tech report + WWDC):**
- Vision backbone **ViTDet-L, 300M params**, Register-Window mechanism. Input up to **1344×1344** via 2×2 tiling. **Three modes:** high-res, **balanced**, and **rapid (224×224)**.
- **Token cost per image: 144 tokens** (standard) → **9 tokens** in **rapid mode**. This is the key lever.
- New API: pass images via `Attachment(...)` / `.image()` content block alongside text; accepts `NSImage`/`CGImage`/`CVPixelBuffer`/file URL — so you can pipe decoded ffmpeg/VideoToolbox frames straight in.
- Image understanding jumped: AFM 3 Core preferred **61%** vs its predecessor.

**Throughput math for Rainy's pipeline (INFERRED):**
- Per keyframe = (image prefill of 9–144 tokens) + (decode of a small `@Generable` description struct, ~40–120 tokens).
- In **rapid mode** (9 img tokens) the per-frame cost is dominated by output decode: ~40–120 tokens ÷ ~50 tok/s ≈ **0.8–2.4 s/frame**. In **balanced** (144 img tokens) add ~0.1–0.3 s prefill.
- A 200-keyframe video ⇒ **~3–8 min** fully local, **free**, **offline**, **batchable in the background**. Downscale frames hard (PySceneDetect already gives you representative frames) and use **rapid mode** for first-pass tagging, **balanced** for frames flagged interesting.

**This is exactly the right tool for scene analysis.** Pair with on-device `OCRTool` / Vision framework for overlay text, and reserve **Claude vision** for "hero" frames (thumbnail candidates, ambiguous scenes) where description quality matters — i.e. **D13 as written.** Use guided generation so each frame returns a typed `SceneDescription` straight into SQLite (no parsing).

```swift
@Generable struct SceneDescription {
    @Guide(description: "One-line what's happening") let summary: String
    @Guide(.count(3)) let tags: [String]
    @Guide(description: "Verbatim on-screen text, or empty") let overlayText: String
    @Guide(.anyOf(["talking-head","b-roll","text-card","action","transition"])) let shotType: String
}
```

---

## 8. Routing verdict for Rainy (refines R8 / D13)

```
Scene analysis (per keyframe):
  default → AFM 3 on-device, image-in-prompt, rapid/balanced, guided → SQLite   [free, offline]
  escalate hero/ambiguous frames → Claude vision                                 [quality]

Real-time canvas agent (per turn):
  hot path / interactive brainstorm  → fast cloud: Groq/Cerebras small (~1000 t/s) or Haiku 4.5
  privacy-preserving but better-than-local → PCC (PrivateCloudComputeLanguageModel, 32K+reasoning)
  OFFLINE / fully-private / no-network → AFM 3 on-device, ONE batched guided `apply_ops` call, streamed
  heavy multi-step planning           → Claude Code over MCP
  (swap in "Codex Spark" on hot path when/if it ships a public API — R7)
```

**Rules of thumb when on-device IS the canvas driver (offline tier):**
- One **batched** guided-generation `CanvasOpBatch` per turn; **stream** it; apply ops per-frame on `@MainActor` (R4). Never one tool-call per node.
- Keep tools ≤ ~6, unambiguous; prefer a single `apply_ops` tool.
- **Distill app state to <~1–2K tokens** before each turn (4K budget). Summarize the canvas, don't dump it.
- Use Dynamic Profiles to swap tool sets / bump reasoning per phase.
- Expect ~3–5 ops/sec and *simpler* layouts than cloud; set product expectations accordingly for the offline mode.

**Where cloud MUST take over:** (1) any brainstorm needing >4K of context or genuine multi-step planning; (2) large-canvas reorganization (dozens of nodes reasoned over jointly); (3) hero-quality scene/thumbnail analysis. On-device cannot match these — by context size and reasoning depth, not by speed.

**Is on-device viable for both?** **Scene analysis: yes, as primary.** **Real-time canvas: yes only as the offline/private fallback tier — not the interactive hero brain.** A dedicated local ultra-fast model is **not required** to ship; the on-device tier + fast-cloud tier already cover the latency floor and the quality ceiling respectively.

---

## Sources

- [Introducing the Third Generation of Apple's Foundation Models — Apple Machine Learning Research](https://machinelearning.apple.com/research/introducing-third-generation-of-apple-foundation-models)
- [Updates to Apple's On-Device and Server Foundation Language Models — Apple ML Research](https://machinelearning.apple.com/research/apple-foundation-models-2025-updates)
- [Introducing Apple's On-Device and Server Foundation Models — Apple ML Research](https://machinelearning.apple.com/research/introducing-apple-foundation-models)
- [Apple Intelligence Foundation Language Models: Tech Report (arXiv 2507.13575, v3)](https://arxiv.org/html/2507.13575v3)
- [Foundation Models — Apple Developer Documentation](https://developer.apple.com/documentation/FoundationModels)
- [What's new in the Foundation Models framework — WWDC26 session 241](https://developer.apple.com/videos/play/wwdc2026/241/)
- [Apple's third-generation Foundation Models explained — 9to5Mac](https://9to5mac.com/2026/06/11/apples-new-foundation-models-explained-on-device-ai-cloud-ai-and-everything-in-between/)
- [The Third Generation of Apple's Foundation Models and AFM Core Advanced — MacStories](https://www.macstories.net/linked/the-third-generation-of-apples-foundation-models-and-afm-core-advanced/)
- [Apple AFM Core Advanced Deep Dive — How 20B Sparse MoE Brings Frontier AI to iPhone — Oflight](https://www.oflight.co.jp/en/columns/apple-afm-core-advanced-wwdc-2026)
- [Apple Foundation Models Explained: What AFM 3 Means for Developers — WisGate](https://wisgate.ai/blogs/apple-afm-3-foundation-models-developer-platform)
- [Apple's Third-Generation Foundation Models: A Developer's Read on WWDC 2026 — ofox.ai](https://ofox.ai/blog/apple-foundation-models-3-wwdc-2026-developer-read/)
- [Local LLM Benchmarks on Apple Silicon: Token Speed M1–M5 — ModelPiper](https://modelpiper.com/blog/local-llm-benchmarks-apple-silicon)
- [Apple Silicon LLM Benchmarks — Real tok/s by Model, Chip & Quantization — LLMCheck](https://llmcheck.net/benchmarks)
- [MLX vs llama.cpp on Apple Silicon: Benchmarks, M5 Neural Accelerators — yage.ai](https://yage.ai/share/mlx-apple-silicon-en-20260331.html)
- [Foundation Models Guided Generation with Apple's iOS 26 Framework — DEV Community](https://dev.to/iniyarajan86/foundation-models-guided-generation-with-apples-ios-26-framework-2m09)
- [Why my Apple Foundation Models feature works in the demo but breaks in the shipped app — Vadim Drobinin](https://drobinin.com/consulting/foundation-models-apple-intelligence/putting-apple-foundation-models-in-a-real-app/)
</content>
</invoke>
