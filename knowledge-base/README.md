# Knowledge Base

Dated, scraped-from-source reference docs. **This is the source of truth for "how to build X" in
Rainy.** Coding agents must read the relevant doc before implementing a feature that touches the
technology. Each doc carries a `_Last updated_` date and a `_Sources_` list of URLs.

> Built against the platform as of **June 2026** (post-WWDC 2026: macOS 27 "Golden Gate",
> Foundation Models v3). Re-scrape when Apple ships GM / new betas.

## Index

### `apple-platform/`
| File | Covers |
|------|--------|
| `macos-27-golden-gate.md` | What's new in macOS 27, Liquid Glass refinements, Apple-silicon-only, dev impact |
| `liquid-glass-swiftui.md` | `glassEffect`, `GlassEffectContainer`, `glassEffectID`, `.interactive()`, HIG, performance, pitfalls |
| `menu-bar-app.md` | `MenuBarExtra`, `NSStatusItem`, `LSUIElement`, popovers, lifecycle |
| `swiftui-macos-app-structure.md` | App/Scene/Window structure, multi-window, Settings, modern project setup |

### `ai-on-device/`
| File | Covers |
|------|--------|
| `foundation-models-v3.md` | On-device LLM API, guided generation, tool calling, image input, sessions, multi-provider, Python SDK |
| `vision-framework.md` | OCR, image classification, object/face detection — for thumbnails & frames |
| `speech-framework.md` | SpeechAnalyzer / Speech — transcription & voice input |
| `writing-tools-app-intents.md` | System Writing Tools + App Intents (Siri/Shortcuts/Spotlight) |

### `mcp/`
| File | Covers |
|------|--------|
| `fastmcp.md` | Building MCP servers with FastMCP (Python): tools, resources, transports, lifecycle |
| `mcp-protocol.md` | MCP spec essentials: tools/resources/prompts, transports (stdio/HTTP), capabilities |
| `claude-code-mcp-integration.md` | Registering & using an MCP server from local Claude Code |

### `models/`
| File | Covers |
|------|--------|
| `realtime-fast-models.md` | Ultra-fast model landscape mid-2026 ("Codex Spark"-class), latency, streaming, routing |

### `canvas/`
| File | Covers |
|------|--------|
| `infinite-canvas-swiftui.md` | Pan/zoom infinite canvas in SwiftUI: Canvas, gestures, performance, node graphs, live updates |

### `architecture-patterns/`
| File | Covers |
|------|--------|
| `python-sidecar-in-mac-app.md` | Bundling/launching a Python (FastMCP) sidecar from a sandboxed Mac app; packaging & entitlements |
| `realtime-app-ipc.md` | Low-latency app⇄sidecar IPC + pushing live updates into SwiftUI (sockets, XPC, file-watch, notifications) |
| `persistence-shared-store.md` | SwiftData/Core Data/SQLite choice + a store both Swift and Python can read/write |

### Added by the feasibility review (2026-06-24)
| File | Covers |
|------|--------|
| `apple-platform/wwdc-2026-developer-tools.md` | **Full June-2026 Apple toolchain**: Xcode 27 (MCP host via `mcpbridge`), Swift 6.4, SwiftUI 2026, Foundation Models v3 `LanguageModel` protocol + MLX/Core AI, `container` machines, App Intents, distribution |
| `architecture-patterns/realtime-agent-loop.md` | Why Claude Code's loop can't do live editing; the two-engine split; Claude Agent SDK; batch-ops-vs-many-calls; latency budget |
| `models/realtime-fast-models-deep.md` | Deep fast-model numbers (TTFT/throughput/tool-calling/structured output) — Groq, Cerebras, Haiku 4.5, Gemini 3 Flash; Codex Spark API status |
| `architecture-patterns/pipeline-feasibility-and-caveats.md` | Download/scene/VLM feasibility + **caveats register** (DMCA §1201, ToS, cost model, storage) |
| `architecture-patterns/video-download-pipeline.md` | `yt-dlp` per-platform (YouTube/TikTok/Instagram), cookies/auth, output layout, ToS |
| `architecture-patterns/scene-analysis-pipeline.md` | PySceneDetect 0.7 API, keyframe extraction, VLM routing, end-to-end pipeline |
| `canvas/live-collaboration-architecture.md` | Agent+user coexistence on the canvas: op/command model, LWW + Lamport order, conflict/ghost layer (no CRDT/OT) |
| `ai-on-device/foundation-models-as-agent-driver.md` | Can on-device FM v3 drive the loop / do scene VLM — latency, tool-calling, structured-output speed |

> **See also `docs/FEASIBILITY.md`** — the decision-grade synthesis of all of the above.

## Conventions for docs in here

- Start with `# Title`, then `_Last updated: YYYY-MM-DD_`.
- Be implementation-focused: APIs, signatures, minimal code samples, gotchas, version availability.
- End with `## Sources` — a list of the actual URLs used.
- When something is beta/uncertain, say so explicitly.
