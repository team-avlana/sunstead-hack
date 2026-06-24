# Apple Foundation Models Framework (v3 / "AFM 3")

_Last updated: 2026-06-24_

Implementation reference for Rainy. Covers Apple's on-device System Language Model API in Swift, structured/guided generation, tool calling, image-in-prompt, availability checks, and the 2026 (AFM 3) updates: rebuilt sparse on-device model, Private Cloud Compute reasoning + 32K context, the new multi-provider `LanguageModel` protocol (bring-any-LLM, incl. Claude/Gemini via Swift packages), the Python SDK, and Linux support.

> **Beta / uncertainty flags.** AFM 3 was introduced at WWDC 2026 (June 8, 2026). Much of the 2026 surface below ships in the iOS/macOS **27** SDK cycle and is, at time of writing, **beta** (developer beta SDKs). Exact symbol names for the *new* 2026 APIs (`PrivateCloudComputeLanguageModel`, `LanguageModel`/`LanguageModelExecutor`, `Attachment`, `DynamicProfile`, the Python SDK module name) are drawn from WWDC sessions and dev write-ups and **may shift before GA** — verify against `developer.apple.com/documentation/FoundationModels` before shipping. The **v1 surface** (`LanguageModelSession`, `respond`, `streamResponse`, `@Generable`, `@Guide`, `Tool`, `SystemLanguageModel.availability`) shipped in iOS/macOS 26 and is stable.

---

## 1. What it is

`import FoundationModels` gives you an on-device LLM with a single Swift API. The core object is a stateful, append-only **`LanguageModelSession`**: you give it instructions + tools, send prompts, and it maintains the prompt/response transcript across calls. As of AFM 3 the same session can be backed by Apple's on-device model, Apple's Private Cloud Compute model, or a third-party model (Claude, Gemini, your own) — all behind the new `LanguageModel` protocol.

Three model "surfaces" conform today:
1. **On-device** — `SystemLanguageModel.default` (rebuilt ~20B-class sparse model in AFM 3), runs locally on Apple silicon, free, private, offline.
2. **Private Cloud Compute** — `PrivateCloudComputeLanguageModel`, 32K context + reasoning, no API keys, private; free for developers under ~2M first-time downloads (beta).
3. **Third-party** — provider Swift packages (Anthropic, Google) that conform to `LanguageModel`.

---

## 2. Availability checks (do this first)

Always gate on availability — on-device inference requires a supported device with Apple Intelligence enabled.

```swift
import FoundationModels

let model = SystemLanguageModel.default

switch model.availability {
case .available:
    // safe to create a session
    break
case .unavailable(let reason):
    // reason ∈ deviceNotEligible, appleIntelligenceNotEnabled,
    //          modelNotReady, ... — degrade gracefully / disable the feature
    break
}
```

Specialized variants exist via use cases, e.g. `SystemLanguageModel(useCase: .contentTagging)`. Check `session.isResponding` before sending a new prompt.

---

## 3. Basic session

```swift
import FoundationModels

let session = LanguageModelSession(
    instructions: {
        "You are a video-analysis assistant. Be concise and factual."
    }
)

// One-shot, full response
let result = try await session.respond(to: "Summarize the key beats of this clip.")
print(result.content)          // String
// result.transcriptEntries holds the running conversation history

// Streaming (snapshots accumulate as generation proceeds)
let stream = try await session.streamResponse(to: "Describe the opening shot.")
for try await partial in stream {
    render(partial)            // incremental text
}
```

`LanguageModelSession(model:guardrails:tools:instructions:)` — `model` defaults to `SystemLanguageModel.default`; `guardrails` currently only `.default`; pass a saved `transcript:` to restore history.

---

## 4. Guided generation — structured output (`@Generable` / `@Guide`)

First-class structured output: annotate a Swift type and the model returns a decoded instance, not a string to parse. The compiler synthesizes the JSON schema and decoding.

```swift
@Generable
struct ThumbnailAnalysis: Equatable {
    @Guide(description: "One-line caption of the dominant subject")
    let caption: String

    @Guide(.anyOf(["high", "medium", "low"]))
    let clickbaitRisk: String

    @Guide(description: "Detected on-image text, verbatim")
    let overlayText: String

    @Guide(.count(3))            // fix array length
    let dominantColors: [String]
}

let analysis = try await session.respond(
    to: "Analyze this thumbnail.",
    generating: ThumbnailAnalysis.self,
    includeSchemaInPrompt: false,                 // default true
    options: GenerationOptions(temperature: 0.3)
)
print(analysis.content.caption)                   // typed ThumbnailAnalysis
```

`@Guide` constraints include: `description:` (NL hint), `.anyOf([...])` (enum), `.count(n)` (array length), and regex for strings.

**Streaming structured output** yields `T.PartiallyGenerated` (every property optional, filled progressively):

```swift
let stream = try await session.streamResponse(
    generating: ThumbnailAnalysis.self,
    includeSchemaInPrompt: false
) { "Analyze this thumbnail." }

for try await partial in stream {
    updateUI(with: partial)      // ThumbnailAnalysis.PartiallyGenerated
}
```

---

## 5. Tool calling (`Tool` protocol)

Let the model invoke your app code. Define a `Tool` with a name, description, a `@Generable` `Arguments` type, and a `call(arguments:)` returning `ToolOutput`.

```swift
import FoundationModels

final class FrameSearchTool: Tool {
    let name = "searchFrames"
    let description = "Find frames in the current video matching a description."

    @Generable
    struct Arguments {
        @Guide(description: "What to look for, e.g. 'person holding a sign'")
        let query: String
        @Guide(description: "Max frames to return")
        let maxResults: Int
    }

    func call(arguments: Arguments) async throws -> ToolOutput {
        let hits = await frameIndex.search(arguments.query,
                                           limit: arguments.maxResults)
        return ToolOutput(hits.map(\.timecode).joined(separator: ", "))
        // ToolOutput accepts a String or a @Generable structured value
    }
}

let session = LanguageModelSession(tools: [FrameSearchTool()]) {
    "Use searchFrames when the user asks where something appears."
}
let r = try await session.respond(to: "Where does the logo first show up?")
```

The framework runs the tool-call loop for you: model emits a call → your `call` runs → result is fed back → model continues until done. **AFM 3 built-in/system tools** (beta): `OCRTool` (structured text from images), `BarcodeReaderTool`, and a local **Spotlight** RAG tool — all on-device.

---

## 6. Image input in prompts (AFM 3 — vision) ⭐ for thumbnails/frames

The rebuilt on-device model accepts images alongside text via `Attachment` in the prompt builder. This is the primary lever for Rainy's thumbnail/frame analysis without any network call.

```swift
let session = LanguageModelSession {
    "You analyze video frames. Identify subjects and any on-screen text."
}

let response = try await session.respond {
    "What is happening in this frame, and what text is overlaid?"
    Attachment(uiImage)          // also: NSImage, CGImage, Core Image,
                                 // CVPixelBuffer (CoreVideo), or a file URL
}
print(response.content)
```

Notes:
- Accepts any size/aspect ratio; **larger images consume more tokens** — downscale frames for cost/latency.
- `CVPixelBuffer` support means you can pipe decoded `AVFoundation`/`VideoToolbox` frames straight in.
- Combine with `generating:` for a typed result (e.g. the `ThumbnailAnalysis` struct above) over an image attachment.
- Pairs with the on-device `OCRTool` / `BarcodeReaderTool` and the Vision framework for OCR/barcode reading on frames.

> Beta: image-in-prompt is new in AFM 3 (iOS/macOS 27 betas). Confirm the exact `Attachment` initializer set before shipping.

---

## 7. Context window, tokens, and reasoning

New AFM 3 inspection APIs:

```swift
let model = SystemLanguageModel()
print(model.contextSize)                       // e.g. 8192 on-device
let n = try await model.tokenCount(for: "…")   // count tokens for a string
```

- **On-device context: ~8K tokens** (8192). Token/context inspection APIs landed in iOS 26.4.
- **Private Cloud Compute: 32K tokens** + reasoning, via `PrivateCloudComputeLanguageModel` (beta). No API keys, prompts never stored, verifiable privacy; now also on watchOS 27.

Reasoning is opt-in per request through context options:

```swift
let session = LanguageModelSession(model: PrivateCloudComputeLanguageModel())
let response = try await session.respond(
    to: "Plan a 3-act edit from these scene descriptions…",
    contextOptions: ContextOptions(reasoningLevel: .light)   // .light / .deep
)
print(response.usage.output.reasoningTokenCount)
```

`response.usage` exposes `input.totalTokenCount`, `input.cachedTokenCount`, `output.totalTokenCount`, `output.reasoningTokenCount`.

---

## 8. Multi-provider — the `LanguageModel` protocol (bring-any-LLM)

AFM 3's headline architectural change: a public **`LanguageModel`** protocol lets *any* model back a `LanguageModelSession`. Apple's own models already conform; **Anthropic and Google are shipping Swift packages** that conform, so you call Claude or Gemini through the exact same API as on-device inference.

```swift
import FoundationModels
import AnthropicLanguageModel        // Anthropic's Swift package (name may vary)

let model = AnthropicLanguageModel() // configured with secure auth (see below)
let session = LanguageModelSession(model: model)
let response = try await session.respond(to: "What is 2 + 2?")
print(response.content)
```

Swapping providers is a one-line change — `@Generable` guided generation, the `Tool` protocol, streaming, `usage`, and error handling all work uniformly. Google ships Gemini via the **Firebase Apple SDK**; Anthropic ships a standalone package. Three conforming surfaces exist today: Apple on-device, Gemini, Claude. Apple also ships open-source executors: **`CoreAILanguageModel`** (Neural Engine) and **`MLXLanguageModel`** (Mac GPU).

### Protocol shape (for building/understanding a provider package)

```swift
public protocol LanguageModel: Sendable {
    var capabilities: LanguageModelCapabilities { get }   // .toolCalling, .guidedGeneration, .reasoning, …
    var executorConfiguration: Executor.Configuration { get }
}

public protocol LanguageModelExecutor: Sendable {
    init(configuration: Configuration) throws
    func prewarm(model: Model, transcript: Transcript)    // optional: warm weights/connections
    func respond(
        to request: LanguageModelExecutorGenerationRequest,
        model: Model,
        streamingInto channel: LanguageModelExecutorGenerationChannel
    ) async throws
}
```

The executor translates the session transcript to the provider's wire format, applies `request.contextOptions` (reasoning level, response schema) and `request.generationOptions` (temperature, `maximumResponseTokens`, sampling), and streams events through the `channel` (metadata first, then usage, then text deltas). The framework caches executors by hashable `Configuration` for KV/connection reuse. Use the built-in `LanguageModelError` (`.contextSizeExceeded`, `.rateLimited`, `.refusal`, `.guardrailViolation`, `.timeout`, …) and add custom errors only for provider-specific states.

**Auth guidance (provider packages):** do **not** take a plain `apiKey: String`. Prefer `init(tokenProvider: @escaping () async throws -> String)` or a sign-in flow; store tokens in **Keychain**; use **App Attest** for device attestation. Never embed keys in the binary.

### Claude-through-FM vs. MCP / Claude Code / the Anthropic SDK — when to use which

`LanguageModel`-via-FM and a direct Anthropic integration solve different problems:

| Need | Use |
|---|---|
| One Swift API across Apple/Claude/Gemini, easy provider swap, native `@Generable` + `Tool` + streaming inside a SwiftUI/AppKit app | **Claude via the Foundation Models `LanguageModel` package** |
| Full Claude API surface — prompt caching, batches, files, server-side tools (web search/code exec), extended thinking/effort, fine-grained control, model pinning | **Anthropic Swift/HTTP SDK directly** (FM abstracts these away) |
| Expose external tools/data to Claude over a standardized protocol, or drive an agentic coding workflow | **MCP / Claude Code** — orthogonal to FM; FM's `Tool` protocol is in-process Swift, not MCP |

The FM route hides HTTP, request/response shapes, sampling config, and auth plumbing — great for app-level uniformity, but you lose direct access to Anthropic-specific features. For Rainy: use **on-device FM (with image-in-prompt)** for fast, private, free per-frame analysis; reach for **Claude via FM** when you want a frontier model behind the same call site; reach for the **Anthropic SDK / MCP / Claude Code** when you need caching, batch jobs, server tools, or agentic tooling that FM doesn't surface.

> See the companion Claude API reference for direct-SDK specifics (models, pricing, tool use, caching). FM does not expose those knobs.

---

## 9. Python SDK (AFM 3, beta)

Apple shipped a Python SDK to call the on-device / PCC models from Python — for scripting, evals, and pipelines on Apple silicon.

```python
import apple_fm_sdk as fm          # module name per Apple's SDK (verify)

model = fm.SystemLanguageModel()
is_available, reason = model.is_available()

session = fm.LanguageModelSession(model=model)
response = await session.respond(prompt="Summarize this transcript.")
print(response.content)
```

Requirements: **Python 3.10+, Xcode, Apple silicon. macOS-only — the Python SDK does NOT run on Linux.** There is also an **`fm` CLI** (macOS 27): `fm chat` for interactive use, pipeable into shell scripts; it can run a local OpenAI-compatible server for tooling that expects that interface.

> Beta: SDK module/package name (`apple_fm_sdk` vs `python-apple-fm-sdk`) and method signatures are pre-GA — verify.

---

## 10. Linux support & open source

Apple confirmed it will **open-source the Foundation Models framework later in summer 2026**. The core framework is Swift, so it **runs on Linux servers via the open-source Swift runtime** — enabling server-side Swift apps to use the same API off-Apple-hardware. (The *on-device Apple model* itself still requires Apple silicon; Linux use is primarily for the framework + third-party/`LanguageModel`-conforming providers and a "Chat Completions" standard interface in the open-source **Foundation Models Framework Utilities** package.)

> Beta/forthcoming: full open-source release is planned for later in 2026; Linux server support arrives with it.

---

## 11. Other AFM 3 additions (brief)

- **Dynamic Profiles** (beta, agentic primitive) — `LanguageModelSession.DynamicProfile`: declaratively switch instructions/tools/model/reasoning level by state *within one session*.
- **Evaluations framework** (new Swift framework) — measure feature quality / prompt-change impact statistically.
- **Utilities package** — transcript-management profile modifiers, a Skill API for procedural knowledge, and a Chat Completions interface.

---

## 12. Hardware / OS requirements (summary)

- **On-device model:** Apple silicon with Apple Intelligence enabled; new context/token APIs in iOS/macOS 26.4+, vision + rebuilt model in the 27 cycle (beta). Always check `SystemLanguageModel.availability`.
- **Private Cloud Compute model:** beta; newly on **watchOS 27**; no keys, free under ~2M first-time downloads.
- **Python SDK / `fm` CLI:** Python 3.10+, Xcode, Apple silicon; macOS 27 for the CLI; **not Linux**.
- **Linux:** framework-only, via open-source Swift runtime (forthcoming, summer 2026).
- **Multi-provider packages (Anthropic/Google):** added via Swift Package Manager; require provider auth (Keychain/App Attest pattern).

---

## Sources

- [Foundation Models — Apple Developer Documentation](https://developer.apple.com/documentation/FoundationModels)
- [Foundation Models updates — Apple Developer Documentation](https://developer.apple.com/documentation/updates/foundationmodels)
- [What's new in the Foundation Models framework — WWDC26 session 241](https://developer.apple.com/videos/play/wwdc2026/241/)
- [Bring an LLM provider to the Foundation Models framework — WWDC26 session 339](https://developer.apple.com/videos/play/wwdc2026/339/)
- [Apple Intelligence Foundation Language Models: Tech Report (2025), arXiv 2507.13575](https://arxiv.org/pdf/2507.13575)
- [Exploring the Foundation Models framework — Create with Swift](https://www.createwithswift.com/exploring-the-foundation-models-framework/)
- [Apple Foundation Models Framework: 2026 Swift Guide — Lush Binary](https://lushbinary.com/blog/apple-foundation-models-framework-swift-guide/)
- [Apple's LanguageModel Protocol: Provider-Agnostic Inference Lands in Swift — pdpspectra](https://pdpspectra.com/blog/apple-foundation-models-languagemodel-protocol-2026/)
- [WWDC 2026 — Apple Just Opened the Foundation Models Framework to Any LLM Provider — DEV Community](https://dev.to/arshtechpro/wwdc-2026-apple-just-opened-the-foundation-models-framework-to-any-llm-provider-5ejn)
- [Apple Open-Sources Its Foundation Models Framework, Adds Claude and Gemini — NYU Shanghai RITS](https://rits.shanghai.nyu.edu/ai/apple-open-sources-its-foundation-models-framework-adds-claude-and-gemini/)
- [Apple Foundation Models WWDC 2026: Multimodal + Python SDK — byteiota](https://byteiota.com/apple-foundation-models-wwdc-2026-multimodal-python-sdk/)
- [Foundation Models from Python: the fm CLI — Blake Crosley](https://blakecrosley.com/blog/foundation-models-python-fm-cli)
- [Apple's `fm` CLI Runs a Local OpenAI-Compatible Server — ChatForest](https://chatforest.com/builders-log/apple-fm-cli-python-sdk-fm-serve-openai-compatible-psotu-wwdc-2026/)
- [Apple Put Its AI on Linux and Made It Free — Mac O'Clock / Medium](https://medium.com/macoclock/apple-put-its-ai-on-linux-and-made-it-free-i-spent-the-weekend-finding-the-catch-3745a6cc0b86)
- [Apple AFM 3 Foundation Models: Developer Platform — JuheAPI](https://www.juheapi.com/blog/apple-afm-3-foundation-models-developer-platform)
- [Apple's Third-Generation Foundation Models: A Developer's Read on WWDC 2026 — ofox.ai](https://ofox.ai/blog/apple-foundation-models-3-wwdc-2026-developer-read/)
