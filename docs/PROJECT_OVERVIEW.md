# Rainy — Project Overview

_Last updated: 2026-06-24_

## Vision

Rainy is a **full agentic software tool for content creators**. The core value proposition:
a creator links videos/channels (their own + competitors'), and through AI agents can trigger
analysis of competition, brainstorm and generate ideas, compare performance, find outliers in
niches, and explore similar creators — all from a native, beautiful macOS app.

## Two product surfaces

### 1. Home (data surface)
Dashboards showing the linked creators/videos and analysis results: performance metrics,
comparisons, outlier detection, niche exploration, similar-creator graphs.

### 2. Infinite Canvas (ideation surface)
A zoomable/pannable canvas for brainstorming and ideating new projects. **This is where the
MCP shines:** a connected agent can read the canvas state and **update it in real time** —
dropping nodes, connecting ideas, attaching analysis, generating thumbnails/outlines, etc.

## The agent layer

Rainy is "agentic" in two complementary ways:

1. **External agent via MCP (Claude Code).** The app **serves an MCP server** (Python + FastMCP,
   stdio transport). A local Claude Code instance connects and gets tools to read app data and
   mutate the canvas/projects. This is the primary heavy-lifting agent.

2. **Real-time agent for live canvas editing.** For true real-time responsiveness we want an
   ultra-fast model ("Codex Spark"-class, or equivalent) so canvas edits feel instant. If a
   sufficiently fast model isn't available, we fall back to Claude Code. For local, offline,
   non-MCP work, the user can use the on-device model (Apple Foundation Models v3) directly.

> Open research item: confirm exactly which "ultra-fast" real-time models exist as of mid-2026,
> their latency/streaming characteristics, and how to route between them. Tracked in
> `knowledge-base/models/`.

## Why native + on-device AI

- **Native macOS (SwiftUI, macOS 27 Golden Gate)** gives us Liquid Glass, the menu bar surface,
  and deep OS integration (Shortcuts, Spotlight, Siri via App Intents).
- **On-device AI (Foundation Models v3, Vision, Speech)** lets us do summarization, transcription,
  thumbnail/frame analysis (OCR + image understanding), and quick generation **locally and
  privately**, without a round trip — ideal for fast, cheap, always-available analysis.

## Key capabilities to wire in (per kickoff decisions)

- **Foundation Models v3** — on-device LLM; now accepts images in prompts. Local analysis & generation.
- **Vision** — OCR + image understanding on thumbnails/frames (titles, faces, objects, text overlays).
- **Speech / SpeechAnalyzer** — transcription of video audio and voice input.
- **Writing Tools + App Intents** — system Writing Tools, plus Siri/Shortcuts/Spotlight automation.

## Non-goals (for now)

- Cross-platform (iOS/web) — macOS first.
- Hosting our own cloud inference — lean on on-device + the user's own Claude Code / agent.
