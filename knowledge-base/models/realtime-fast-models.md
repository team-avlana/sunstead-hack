# Real-Time & Low-Latency Models for Rainy

_Last updated: 2026-06-24_

Reference for choosing ultra-fast, low-latency LLMs to drive Rainy's infinite canvas with an AI agent editing in **real time**. The priority is **time-to-first-token (TTFT)** and **sustained tokens/sec (TPS)** so canvas edits feel instantaneous, with tool-calling for structured canvas mutations and streaming for incremental rendering.

> **Confidence legend:** ✅ confirmed from primary/official source · 🟡 reported by reputable secondary source · 🔶 rumored / preview / unverified. Numbers from independent benchmarks (Artificial Analysis, etc.) vary by load and date — treat all latency/throughput figures as approximate.

---

## "Codex Spark" — what it actually is

The user's reference to **"Codex Spark"** almost certainly means **OpenAI GPT‑5.3‑Codex‑Spark**, announced **2026‑02‑12**. ✅

- It is a **smaller, speed-optimized variant of GPT‑5.3‑Codex**, OpenAI's **first model designed for real-time coding** ("stay in flow, iterate fast"). ✅
- It runs on **Cerebras wafer-scale hardware** (not Nvidia GPUs) — the first milestone of OpenAI's Jan‑2026 Cerebras partnership — and clocks **>1,000 tokens/sec**, roughly **~15× faster** than standard GPT‑5.3‑Codex. ✅
- **Trade-off:** speed over depth. Reported **~56% on SWE-Bench Pro vs. ~72%** for full Codex 5.3. 🟡 Good for rapid prototyping, targeted edits, and iterative frontend loops; weak on multi-step architecture and stateful debugging.
- **Specs:** **128k context**, **text-only** (no multimodal) at launch. ✅
- **Availability (as of 2026‑06):** **research preview, ChatGPT Pro only**, via the Codex app, CLI, and VS Code extension. **API access is limited to select design partners**; there is **no public API and no published per-token price** for Spark yet. 🔶 (Standard GPT‑5.3‑Codex *is* on the API at ~$1.75/1M in, ~$14.00/1M out.) 🟡

**Implication for Rainy:** Codex‑Spark is the *spiritual fit* (purpose-built for real-time iteration) but is **not yet API-accessible for production**, and it's coding-specialized + text-only. Until it gets a general API, the practical real-time options below are the ones to build on.

---

## The fast-model landscape (mid‑2026)

### OpenAI

| Model | TTFT | Throughput | Context | Streaming | Tools | Pricing (≈/1M) | Status |
|---|---|---|---|---|---|---|---|
| **GPT‑5.3‑Codex‑Spark** 🔶 | near-instant (Cerebras) | **>1,000 t/s** ✅ | 128k ✅ | likely (preview) 🔶 | not documented 🔶 | unpublished 🔶 | Research preview, ChatGPT Pro only; no public API |
| **GPT‑5.4‑mini** 🟡 | low | fast | large | yes | yes (Responses + Chat Completions) | not captured here | "fast, efficient mini for responsive coding/subagents" |

API shape: OpenAI **Responses API** (preferred for agents/tools) and **Chat Completions**. Both support streaming (SSE) and function/tool calling. ✅

### Anthropic — Claude Haiku 4.5

- **TTFT ~0.78s, ~92 t/s** (Artificial Analysis). 🟡 Runs **4–5× faster than Sonnet 4.5**. 🟡
- **200k context**, up to **64k output**. ✅ Multimodal (text + images). First Haiku with **extended thinking, computer use, context awareness**. ✅
- **Streaming + tool calling** fully supported via the Messages API; prompt caching (up to 90% savings) and batch (50%). ✅
- **Pricing: $1/1M in, $5/1M out.** ✅ Released 2025‑10‑15.
- **API shape:** Anthropic Messages API — and notably available **on-device-adjacent via the Apple Foundation Models framework** (Anthropic + Google Swift packages announced at WWDC26, see below). 🟡

### Google — Gemini Flash / Flash‑Lite

- **Gemini 2.5 Flash‑Lite:** lightweight reasoning model **optimized for ultra-low latency**; lower latency than 2.0 Flash/Flash‑Lite. 🟡
- **1,048,576-token context**, up to ~65k output. ✅
- **Streaming + tool calling** (Google Search grounding, code execution), multimodal input. **Thinking is OFF by default for speed**, toggleable via reasoning param. ✅
- **Pricing: $0.10/1M in, $0.40/1M out** (Batch: $0.05/$0.20). ✅ — the **cheapest** of the cloud fast-tier options.
- Newer **Gemini 3.x Flash** tiers exist in 2026 pricing pages 🔶 — verify exact current SKU before committing.
- **API shape:** Gemini API / Vertex AI; SSE streaming, function calling.

### Groq (LPU-hosted open models)

- Hosts open models with **sub-100ms TTFT** and very high TPS. Best feel for **interactive** workloads (low TTFT). 🟡
- Representative throughput: **gpt‑oss‑20B ~956 t/s**, **Llama 3.1 8B ~691 t/s**; **gpt‑oss‑120B TTFT ~0.70s**. 🟡
- Catalog (~11 models): gpt‑oss‑120B/20B, Llama 4 Scout, Llama 3.3 70B, Llama 3.1 8B, Qwen3 32B, Qwen3.6 27B, **Kimi K2** (strongest reasoning, $1/$3 per 1M). 🟡
- **Streaming + tool calling** supported (incl. built-in web search / code execution via **Groq Compound**). ✅
- **Pricing: ~$0.05–$0.90/1M in** (e.g., Llama 3.1 8B $0.05; gpt‑oss‑20B $0.10). 🟡
- **API shape:** **OpenAI-compatible** Chat Completions endpoint — easy drop-in.

### Cerebras (wafer-scale inference)

- **Highest raw throughput** in independent tests: **~3,000 t/s on gpt‑oss‑120B** (Artificial Analysis showed Cerebras **>6×** Groq on identical models); up to **~4,000 t/s** with speculative decoding (3B draft + 70B verifier). 🟡
- Hosts the **Codex‑Spark preview** for OpenAI. ✅
- Best for **full-completion speed** (finish a long edit fastest); Groq often **feels** snappier on TTFT for short interactive turns. 🟡
- **API shape:** OpenAI-compatible Chat Completions; streaming + tools on supported models.

### Notable open models (host-agnostic)

- **gpt‑oss‑20B / gpt‑oss‑120B** — OpenAI's open-weight models; the 20B is a sweet spot for speed on Groq/Cerebras. 🟡
- **Llama 3.1 8B / Llama 4 Scout** — tiny + fast, good for cheap high-frequency edits. 🟡
- **Qwen3 / Qwen3.6**, **Kimi K2** (reasoning-heavy, slower/pricier). 🟡

### Apple Foundation Models (on-device / local) — WWDC26

- **On-device model rebuilt from the ground up**, better at logic and **tool calling**. ✅
- Framework supports **guided generation, streaming, tool calling, multimodal (vision) prompts, and model profiles**; new **dynamic profiles** primitive for agentic experiences. ✅
- **iOS/macOS 26.4** adds APIs to **inspect context size and count tokens**. On-device context is small; **Private Cloud Compute** server model offers **~32k context** with reasoning levels, **no API keys/auth**. ✅
- **WWDC26:** framework **opened to any LLM provider** — **Anthropic (Claude) and Google (Gemini) shipping Swift packages**, so Rainy could call cloud frontier models through the *same* Swift API surface. 🟡
- **Cost: free / local**, fully **offline-capable**, privacy-preserving. ✅

---

## Routing recommendation for Rainy

Rainy should use a **tiered router** keyed on (a) latency sensitivity, (b) task complexity, and (c) connectivity/privacy.

### Tier 1 — Live canvas edits (the hot path)
Single-element edits, drag-to-restyle, "make this bigger/blue," incremental layout nudges — needs **sub-second TTFT** and **streaming partial results** so the canvas updates as tokens arrive.

- **Primary: Groq-hosted small model** (gpt‑oss‑20B or Llama 3.1 8B) — lowest TTFT, OpenAI-compatible API, tool calling for structured canvas mutations. Best "feels instant" choice **available today**.
- **Alternative: Cerebras** when a single edit is long (more tokens) — wins on full-completion time.
- **Watch: GPT‑5.3‑Codex‑Spark** — the *intended* model for exactly this loop; **adopt once it has a public API**. Until then it's preview-only.
- **Quality-leaning option: Claude Haiku 4.5** — slightly higher TTFT (~0.78s) but stronger reasoning, vision, computer use, 200k context, robust tool calling. Use when edits need to "understand" the canvas, not just transform it.

### Tier 2 — Local / offline / privacy
No network, sensitive content, or instant trivial edits.

- **Apple Foundation Models (on-device)** — free, offline, streaming + tool calling, vision input. Use for simple structured edits and as the **fallback when offline**. Small context is the main limit; route anything large up to a cloud tier.

### Tier 3 — Heavy work (off the hot path)
Multi-step refactors of the whole canvas, generating large structures, "redesign this board," planning, multi-file/agentic operations.

- **Claude Code via MCP** (or a frontier model: GPT‑5.5 / Claude Opus / Gemini Pro). Run **async/in the background** with a progress indicator — these are not real-time, but they do the deep work the fast tier can't (Codex‑Spark itself is explicitly weak at multi-step architecture and stateful debugging).

### Router heuristics
1. **Default live edits → Tier 1 fast model** (Groq/Cerebras small model or Haiku 4.5), streaming on.
2. **Offline or privacy flag → Tier 2 Apple on-device.**
3. **Escalate to Tier 3** when the request spans many elements, needs planning, or the fast model's tool-call confidence is low.
4. **Keep one API surface:** Groq/Cerebras are OpenAI-compatible; Apple's framework can wrap Claude/Gemini via Swift packages — minimize integration branches.

---

## Confirmed vs. rumored — quick ledger

- ✅ **Confirmed:** Codex‑Spark exists, >1,000 t/s on Cerebras, 128k, text-only, preview/ChatGPT‑Pro‑only. Haiku 4.5 specs/pricing. Gemini 2.5 Flash‑Lite specs/pricing. Groq/Cerebras throughput class. Apple FM framework capabilities (WWDC26).
- 🟡 **Reported (secondary):** exact t/s and TTFT numbers (Artificial Analysis and vendor blogs vary). SWE-Bench Pro ~56% for Spark. Anthropic/Google Swift packages for Apple FM.
- 🔶 **Rumored / unsettled:** Codex‑Spark public API + pricing (none yet, design-partner only). Exact current Gemini 3.x Flash SKUs. Whether Spark gains streaming/tool-calling parity with full Codex.

**Action item:** re-check Codex‑Spark API availability + pricing periodically — it is the best-fit model for Rainy's core loop the moment it leaves preview.

---

## Sources

- [Introducing GPT‑5.3‑Codex‑Spark — OpenAI](https://openai.com/index/introducing-gpt-5-3-codex-spark/)
- [Introducing OpenAI GPT‑5.3‑Codex‑Spark Powered — Cerebras](https://www.cerebras.ai/blog/openai-codexspark)
- [GPT‑5.3‑Codex‑Spark — Simon Willison](https://simonwillison.net/2026/Feb/12/codex-spark/)
- [OpenAI Codex‑Spark Achieves Ultra-Fast Coding Speeds on Cerebras — InfoQ](https://www.infoq.com/news/2026/03/open-ai-codex-spark/)
- [OpenAI's new Codex Spark model is built for speed — The New Stack](https://thenewstack.io/openais-new-codex-spark-is-optimized-for-speed/)
- [OpenAI released GPT‑5.3‑Codex‑Spark — Help Net Security](https://www.helpnetsecurity.com/2026/02/13/openai-gpt-5-3-codex-spark/)
- [Models — Codex | OpenAI Developers](https://developers.openai.com/codex/models)
- [Pricing — Codex | OpenAI Developers](https://developers.openai.com/codex/pricing)
- [Claude Haiku 4.5 — Anthropic](https://www.anthropic.com/claude/haiku)
- [Introducing Claude Haiku 4.5 — Anthropic](https://www.anthropic.com/news/claude-haiku-4-5)
- [Anthropic — Intelligence, Performance & Price | Artificial Analysis](https://artificialanalysis.ai/providers/anthropic)
- [Gemini 2.5 Flash‑Lite is now stable and GA — Google Developers Blog](https://developers.googleblog.com/en/gemini-25-flash-lite-is-now-stable-and-generally-available/)
- [Gemini 2.5 Flash‑Lite — Google Cloud Documentation](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/2-5-flash-lite)
- [Supported Models — GroqDocs](https://console.groq.com/docs/models)
- [Understanding and Optimizing Latency — GroqDocs](https://console.groq.com/docs/production-readiness/optimizing-latency)
- [Groq — Intelligence, Performance & Price | Artificial Analysis](https://artificialanalysis.ai/providers/groq)
- [Groq vs Cerebras: LLM Inference Speed Comparison 2026 — Speko](https://speko.ai/benchmark/groq-vs-cerebras)
- [Cerebras CS-3 vs. Groq LPU — Cerebras](https://www.cerebras.ai/blog/cerebras-cs-3-vs-groq-lpu)
- [Fastest LLM Inference APIs in 2026: TTFT and Throughput — Inworld](https://inworld.ai/resources/fastest-llm-inference-api)
- [What's new in the Foundation Models framework — WWDC26](https://developer.apple.com/videos/play/wwdc2026/241/)
- [Bring an LLM provider to the Foundation Models framework — WWDC26](https://developer.apple.com/videos/play/wwdc2026/339/)
- [Foundation Models | Apple Developer Documentation](https://developer.apple.com/documentation/FoundationModels)
