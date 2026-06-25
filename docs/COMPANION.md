# Rainey — the companion (plan)

_Last updated: 2026-06-24._ Plan for Rainy's desktop companion. Not built yet beyond a placeholder
(`src/canvas-ui/components/Companion.tsx`). Inspired by [farzaa/clicky](https://github.com/farzaa/clicky).

## Concept
**"Rainey"** is Rainy's mascot — a small **red reindeer** (the red-nosed reindeer; red, not clicky's
blue) that **follows you around the screen** and helps with the whole video preproduction / editing
flow: spotting outliers, drafting ideas, narrating what the agent is doing, and **pointing at things
on screen** (your editor, the canvas) like a tutor sitting next to your cursor.

## What clicky does (reference)
Native **Swift macOS** menu-bar app. Two `NSPanel`s: a control dropdown + a **full-screen transparent
overlay**. Push-to-talk voice (⌃⌥) → AssemblyAI transcription → Claude (with a ScreenCaptureKit
screenshot, streaming) → ElevenLabs TTS. Claude emits `[POINT:x,y:label:screenN]` tags that animate a
cursor to point at UI across monitors. A Cloudflare Worker proxies API keys so they aren't shipped in
the binary.

## How Rainey fits Rainy
- The companion is **another surface for the same agent** (the user's Claude over MCP). It can call
  the same `python-service` MCP tools (analyze a video, create/update artifacts on the canvas) and
  **narrate + point** while they happen.
- It bridges **screen ↔ canvas**: "this competitor opens cold — want three hook options?" → triggers
  analysis → artifacts appear on the canvas → Rainey points at them.

## Tech approach (native, in `src/mac-app`) — lean on-device where we can
- **Overlay:** borderless, transparent, always-on-top `NSPanel` (`.nonactivatingPanel`, high window
  level, mouse-ignoring toggled) full-screen for the character + pointing; a `MenuBarExtra` for
  control. See `knowledge-base/apple-platform/menu-bar-app.md`.
- **See the screen:** ScreenCaptureKit (same as clicky).
- **Voice in:** on-device **SpeechAnalyzer / Speech** (`knowledge-base/ai-on-device/speech-framework.md`)
  instead of AssemblyAI — local, private, free.
- **Brain:** the user's **Claude** (vision + streaming) via MCP/agent; or **Foundation Models v3**
  on-device for quick/offline help (`knowledge-base/ai-on-device/foundation-models-v3.md`).
- **Voice out:** system `AVSpeechSynthesizer` (ElevenLabs later if we want a branded voice).
- **Pointing:** adopt clicky's `[POINT:x,y:label:screenN]` convention to drive the overlay; map
  canvas-space points through the WebView bridge when pointing at the canvas.
- **Keys:** if any cloud key is needed, proxy via a small worker like clicky — never ship keys.

## Phasing
1. **Now (done):** in-app placeholder `Companion.tsx` in `canvas-ui` (draggable red Rainey + speech
   bubble) so the running shell shows the concept.
2. **Next:** native `mac-app` overlay companion (`NSPanel`) — character + bubble, no AI yet.
3. **Then:** voice (on-device) + Claude streaming + pointing; wired to the MCP tools.

## Brand
Red reindeer-nose character. The full mark (a raindrop that grows antlers) + palette + the name
"Rainey" come from `design/index.html` (Adrian's design system). Keep the placeholder neutral until
that lands.

## Open questions
- On-device (SpeechAnalyzer + Foundation Models) vs cloud (AssemblyAI + Claude + ElevenLabs) per
  capability — balance latency / quality / cost (ties into `docs/DECISIONS.md` D16 routing).
- Does Rainey point at **arbitrary apps** (needs Accessibility + Screen-Recording permissions) or
  only at **Rainy's own windows/canvas** to start (fewer permissions)?
