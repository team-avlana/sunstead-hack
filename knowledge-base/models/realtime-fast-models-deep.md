# Real-Time Fast Models — Deep Dive for Rainy's Canvas Hot Path

_Last updated: 2026-06-24_

This is a **deep, implementation-focused** follow-up to `realtime-fast-models.md`. It does **not** repeat the high-level landscape; instead it (a) **re-verifies** every fast-tier claim with June-2026 sources, (b) adds the **new mid-2026 entrants** that changed the picture (Gemini 3 / 3.1 Flash family, DeepSeek V4 Flash, Groq's Llama deprecation, MiniMax M2.7), (c) drills into the **specific capability that matters for the canvas loop — streaming *structured* output under tool-calling**, and (d) ends with a concrete, named routing table for Rainy.

> **Confidence legend:** ✅ confirmed (primary/official) · 🟡 reported (reputable secondary, e.g. Artificial Analysis/vendor blog) · 🔶 rumored / preview / unverified. All latency/throughput numbers are load-dependent — treat as approximate and re-bench on your own prompts.

> **The single most important framing for Rainy:** the canvas hot path is not "generate a long completion fast." It is "emit a *stream of small, well-formed structured canvas operations* with low TTFT and reliable tool/JSON formatting, while reasoning *just enough* to lay things out sensibly." That reframes the winner set: raw tokens/sec (where Cerebras dominates) matters far less than **TTFT + structured-output reliability + good-enough spatial reasoning**.

---

## 1. Re-verification: GPT-5.3-Codex-Spark — still NOT publicly usable (June 2026)

**Status unchanged since Feb 2026, and this is now load-bearing for Rainy: do not architect around Spark.**

- **Still research preview, ChatGPT **Pro-only** ($200/mo)**, via Codex app / CLI / VS Code extension. Plus plan still excluded. **No public API, no published per-token price.** ✅ (OpenAI launch post + CometAPI + multiple June reviews all consistent.)
- **API access remains limited to a small set of design partners** for "early integration experiments"; OpenAI says it will "expand access over the coming weeks" — but **as of June 2026 no broad API and no date**. 🟡 The "coming weeks" language has now been outstanding ~4 months.
- **Third-party aggregator path exists but is not production-grade:** CometAPI claims it is "integrating" Spark "at ~80% of OpenAI's price" — but **no actual price is published**, and this would route your hot path through an unofficial reseller. 🔶 Not recommended for a shipping product.
- **Specs (confirmed):** 128k context, **text-only** (no vision), runs on **Cerebras wafer-scale** at **>1,000 tok/s (~15× full Codex 5.3)**. ✅ Real-world task: ~50 sec vs ~6 min for full Codex. 🟡
- **The disqualifier for an agentic canvas loop:** independent review flags **inconsistent JSON-schema reliability and tool-call formatting under complex prompts** — explicitly "a concern for agentic pipelines that depend on structured output." 🟡 Benchmarks: SWE-Bench Pro **~56%** (vs ~72% full Codex), Terminal-Bench 2.0 **77.3%**. It is **fast-but-shallow** and weak at multi-step/stateful work.

**Verdict for Rainy:** Spark is the *spiritual* fit (purpose-built for real-time iteration) but is **(1) inaccessible via a production API, (2) text-only — can't see canvas keyframes, and (3) reportedly shaky on the exact thing we need: structured tool-call output.** Keep it on a watchlist; build on the models below. **No change to the previous doc's "watch, don't adopt" call — now with the added reason that its structured-output reliability is questionable even if the API opens.**

---

## 2. What actually changed since the first doc (the deltas that matter)

1. **Gemini *3* Flash family shipped and reset the fast-tier quality bar.** Gemini 3 Flash (GA Dec 17, 2025) and **Gemini 3.1 Flash-Lite** (Mar 2026) are now the relevant Google SKUs — *not* 2.5 Flash-Lite. Gemini 3 Flash brings **Pro-grade reasoning at Flash latency** with **configurable thinking levels (minimal/low/medium/high)** — directly tunable for a hot loop. ✅
2. **Groq deprecated its small Llama models.** On **2026-06-17**, Groq announced deprecation of `llama-3.1-8b-instant` and `llama-3.3-70b-versatile`, steering users to **`openai/gpt-oss-20b` / `gpt-oss-120b` / `qwen/qwen3.6-27b`**. ✅ **This invalidates the prior doc's "Llama 3.1 8B on Groq" Tier-1 recommendation** — the new Groq hot-path pick is **gpt-oss-20B**.
3. **DeepSeek V4 Flash (Apr 24, 2026)** is a new ultra-cheap, tool-calling, 1M-context option — relevant as a cost floor, though its native ~110 tok/s and reasoning-style latency make it a *cost* play, not a *latency* play.
4. **New raw-speed entrants:** SambaNova publishes **~435 tok/s on MiniMax M2.7**; Cerebras publishes **~2,000 tok/s on Llama 4 Scout** and **~3,000 tok/s on gpt-oss-120B**. Raw-throughput ceiling keeps rising but is not the canvas bottleneck.
5. **Anthropic fast tier is unchanged:** **Haiku 4.5 is still the current/fastest Haiku** as of June 2026 — *no Haiku 4.6 exists* (claims of a "4.6" are unverified/incorrect; official lineup June 2026 = Opus 4.8, Sonnet 4.6, Haiku 4.5, plus the new top-tier **Fable 5**, GA 2026-06-09). 🟡 Fable 5 is a frontier model, **not** a fast-tier option.

---

## 3. The genuinely usable hot-path options — concrete numbers (June 2026)

All numbers are mid-2026 from Artificial Analysis, vendor docs, or vendor blogs. **TTFT figures are the make-or-break metric for "feels instant"; tokens/sec only matters for longer single emissions.**

### 3.1 Comparison table (hot-path candidates)

| Model (host) | TTFT | Output tok/s | Context | Streaming | Tool calling | **Streaming structured output** | Price /1M (in / out) | "Smart enough" to lay out a board? |
|---|---|---|---|---|---|---|---|---|
| **gpt-oss-20B (Groq)** ✅ | **sub-100ms class** 🟡 | **~955–1000** ✅ | 131,072 ✅ | yes ✅ | yes ✅ | yes (Groq JSON-schema + tools) 🟡 | **$0.075 / $0.30** 🟡 | Borderline — fast, *medium* reasoning; fine for nudges/restyle, weak on whole-board planning |
| **gpt-oss-120B (Groq)** ✅ | ~0.7s 🟡 | ~500 ✅ | 131,072 ✅ | yes ✅ | yes ✅ | yes 🟡 | ~$0.15 / $0.60 (class) 🟡 | Yes — good speed/quality balance for layout |
| **gpt-oss-120B (Cerebras)** ✅ | low 🟡 | **~3,000** 🟡 | 131,072 ✅ | yes ✅ | yes ✅ | yes (JSON-schema enforced) ✅ | ~$0.25–0.69 class 🟡 | Yes — best when an op stream is long |
| **Qwen3.6-27B (Groq/Cerebras)** 🟡 | low 🟡 | high (Cerebras ~2,600 on Qwen3-32B) 🟡 | ~131k+ 🟡 | yes ✅ | yes ✅ | yes 🟡 | low (Groq small-model class) 🟡 | Yes — strong reasoning-per-token; good board planner candidate |
| **Claude Haiku 4.5 (Anthropic)** ✅ | **~0.58–0.78s** (Vertex 0.58 / Anthropic 0.75–0.78) 🟡 | **~92–111** (Anthropic 94.6, Amazon 110.9) 🟡 | **200k**, 64k out ✅ | yes ✅ | yes (robust) ✅ | yes (tool-use streaming) ✅ | **$1 / $5** ✅ | **Yes — best reasoning of the fast tier**; multimodal (can *see* keyframes) |
| **Gemini 3 Flash (Google)** ✅ | ~Flash-class w/ minimal thinking; reasoning variant ~7.5s w/ thinking on 🟡 | ~182 (non-reasoning) ✅ | ~1M ✅ | yes ✅ | yes ✅ | yes — **uniquely** combines JSON-schema + built-in tools in one request ✅ | **$0.50 / $3** ✅ | **Yes — Pro-grade reasoning**, thinking levels tunable (minimal→fast); multimodal |
| **Gemini 3.1 Flash-Lite (Google)** ✅ | **5.6s** (reasoning ON by default!) 🟡 | **359** 🟡 | **1M** ✅ | yes ✅ | yes ✅ | yes ✅ | **$0.25 / $1.50** (cache hit $0.025) 🟡 | Cheap + high tok/s, but **default TTFT is bad** — must force minimal thinking |
| **DeepSeek V4 Flash** ✅ | reasoning-style (not low) 🟡 | ~110 🟡 | **1M** ✅ | yes ✅ | yes (+ JSON, Anthropic-compatible API) ✅ | yes 🟡 | **$0.09–0.14 / $0.18–0.28** (cache $0.0028) 🟡 | Cost floor, not a latency play — **skip for hot path** |
| **GPT-5.3-Codex-Spark** 🔶 | near-instant (Cerebras) | **>1,000** ✅ | 128k ✅ | yes (WebSocket) 🔶 | **shaky under load** 🟡 | **reported unreliable** 🟡 | unpublished, no API 🔶 | N/A — not usable; text-only |

> **Latency caveat that bites:** several "Flash/Lite" 2026 models default to **reasoning ON**, which destroys TTFT (Gemini 3.1 Flash-Lite shows **5.6s** TTFT precisely because thinking is on). For a hot loop you **must** set the thinking/reasoning level to **minimal/off** and re-measure. Gemini 3 Flash with `thinking_level: minimal` is the intended fast config; the 7.5s number is the *reasoning-on* path.

### 3.2 Fast-but-dumb vs fast-AND-smart-enough

- **Fast but dumb (raw speed, weak layout reasoning):** Groq **gpt-oss-20B**, Llama-class small models, **Codex-Spark** (also unusable). Great for *mechanical* ops ("move 10% right", "recolor", "align"), poor at *deciding* a board structure.
- **Fast AND smart enough (the band Rainy needs for live brainstorm layout):**
  - **Gemini 3 Flash** — Pro-grade reasoning (GPQA Diamond 90.4%, SWE-bench Verified 78%), tunable thinking, multimodal, best-in-class structured-output+tools fusion, 1M context. **Top pick on capability.**
  - **Claude Haiku 4.5** — best *robustness* of tool-calling in the fast tier, multimodal (can read your ffmpeg keyframes), 200k context, ~0.6–0.8s TTFT. **Top pick on reliability.**
  - **gpt-oss-120B (Cerebras)** — when you want open-weight + extreme throughput + good-enough reasoning and enforced JSON schema.

---

## 4. The capability that decides it: streaming STRUCTURED output under tool-calling

Rainy's canvas updates as ops arrive, so we want to **stream a sequence of JSON canvas operations** (or stream a tool call that *is* a canvas op) and apply each as it parses. Verified support:

- **Cerebras:** structured outputs with **JSON-schema enforcement**, **streaming**, and **tool use** are all first-class in the Inference SDK; OpenAI-compatible. ✅ Good for an enforced op-schema stream.
- **Gemini 3 Flash:** supports streaming + function calling + **JSON-schema structured output**, and is **uniquely able to combine structured JSON output with built-in tools (Search/URL/Code) in one request**. JSON Schema (Pydantic/Zod) works out-of-the-box across actively supported Gemini models. ✅
  - **⚠️ Known bug to guard against:** there are June-2026 reports (vercel/ai #11396) that **Gemini 3 Pro/Flash preview emit internal JSON as *text* when tools are also provided** — i.e. structured-output + tools can leak raw JSON into the text channel. **Test your exact tools+schema combo before relying on it.** 🟡
- **Groq (gpt-oss-20B/120B, Qwen3.6-27B):** OpenAI-compatible Chat Completions with streaming + tool calling + JSON-schema/`response_format`. ✅ Easiest drop-in (OpenAI SDK pointed at Groq base URL).
- **Anthropic Haiku 4.5:** streaming tool-use via Messages API; tool calls stream as `input_json_delta` events — you can parse partial tool-input JSON for incremental canvas application. ✅ Most *predictable* tool formatting of the group.
- **Apple Foundation Models (on-device):** `@Generable`/guided generation gives **streaming structured output** as the model fills a typed Swift struct, plus tool calling and vision prompts (WWDC26). ✅ This is the cleanest *typed-stream* ergonomics of any option — but small on-device context.

**Implication:** for an op-stream loop, the most reliable combinations are **Cerebras (enforced JSON schema) and Anthropic Haiku (partial tool-input deltas)**. Gemini 3 Flash is the most *capable* but verify the tools+schema bug on your prompts first.

---

## 5. Concrete loop sketch (host-agnostic, OpenAI-compatible hot path)

```python
# Hot-path: stream canvas ops as a tool-call argument stream.
# Works against Groq / Cerebras / OpenAI-compatible endpoints (gpt-oss-20B|120B).
client = OpenAI(base_url=GROQ_BASE_URL, api_key=GROQ_KEY)  # or Cerebras base URL

CANVAS_OP = {  # one tool = one structured op the canvas knows how to apply
  "type": "function",
  "function": {
    "name": "emit_canvas_op",
    "parameters": {
      "type": "object",
      "properties": {
        "op":   {"type": "string", "enum": ["add","move","restyle","group","connect","label"]},
        "id":   {"type": "string"},
        "x":    {"type": "number"}, "y": {"type": "number"},
        "props":{"type": "object"}
      },
      "required": ["op"], "additionalProperties": False
    }
  }
}

stream = client.chat.completions.create(
    model="openai/gpt-oss-20b",          # Groq hot path; swap to gpt-oss-120b / cerebras for harder boards
    messages=[{"role":"system","content": LAYOUT_SYSTEM_PROMPT},
              {"role":"user","content": user_intent}],
    tools=[CANVAS_OP], tool_choice="required",
    stream=True, temperature=0.4,
    # Gemini 3 Flash equivalent: thinking_level="minimal" to keep TTFT low
)
buf = ""
for chunk in stream:
    delta = chunk.choices[0].delta
    for tc in (delta.tool_calls or []):
        buf += tc.function.arguments or ""
        for op in drain_complete_json_objects(buf):   # apply each op the instant it parses
            canvas.apply(op)                            # -> SQLite (WAL) -> live MCP/canvas
```

Notes: keep the **system prompt tiny and cached**, pin a **strict op schema**, set **`tool_choice="required"`**, and **apply ops incrementally** rather than waiting for the full message. On Cerebras use enforced JSON-schema; on Anthropic, switch to the Messages API and parse `input_json_delta`.

---

## 6. Routing recommendation for Rainy (named models, June 2026)

A tiered router keyed on **latency sensitivity · task complexity · connectivity/privacy**. This *supersedes* the prior doc's Tier-1 pick (Llama 3.1 8B is now deprecated on Groq).

### Tier 0 — On-device / offline / privacy (no network, trivial edits, sensitive content)
- **Apple Foundation Models (on-device)** with `@Generable` guided generation. Free, offline, **typed streaming** structured output + tool calling + vision. Limited context → escalate anything large. **Fallback whenever offline.**

### Tier 1 — Live canvas HOT PATH (sub-second TTFT, streaming ops)
- **Primary: Groq `gpt-oss-20B`** — lowest TTFT class, ~955–1000 tok/s, OpenAI-compatible, JSON-schema + tools, **$0.075/$0.30**. Best "feels instant" for mechanical/single ops. *(Replaces the deprecated Llama 3.1 8B pick.)*
- **When an op-stream is long or the board is denser: Cerebras `gpt-oss-120B`** — ~3,000 tok/s, **enforced JSON schema**, finishes long emissions fastest.
- **Quality-leaning hot path (default for *real layout*, not just transforms): Gemini 3 Flash with `thinking_level: minimal`** — Pro-grade reasoning at Flash latency, multimodal, best structured-output+tools fusion. The single best "fast **and** smart" option *if* the tools+schema text-leak bug checks out on your prompts.

### Tier 2 — "Understands the canvas" reasoning (needs vision / robust tool calls, still interactive)
- **Claude Haiku 4.5** — ~0.6–0.8s TTFT, **most reliable tool formatting** in the fast tier, **multimodal so it can read your ffmpeg keyframes / VLM context**, 200k context, $1/$5. Use when an edit must *understand* the board, not just transform it. Also reachable through the WWDC26 Apple FM Swift package for a unified Swift surface.
- **Alt: Groq/Cerebras `Qwen3.6-27B`** — strong reasoning-per-token at small-model speed if you want to stay open-weight.

### Tier 3 — Heavy / off the hot path (whole-board redesign, planning, multi-step agentic)
- **Claude Code via MCP** (the project's existing integration) or a frontier model — **Gemini 3.1 Pro**, **Claude Opus 4.8 / Sonnet 4.6**, **GPT-5.5**. Run **async with a progress indicator**; not real-time. This is where the deep multi-step work the fast tier (and Codex-Spark) explicitly can't do lives.

### Tier 4 — Cost floor / batch (non-interactive enrichment, bulk re-labeling)
- **DeepSeek V4 Flash** ($0.09–0.14 / $0.18–0.28, 1M context, tool calling) or **Gemini 3.1 Flash-Lite** ($0.25/$1.50, cache $0.025). Great for cheap bulk passes; **not** for the hot path (their default latency is high).

### Router heuristics (updated)
1. **Default live op-stream → Tier 1.** Mechanical edits → `gpt-oss-20B` (Groq). "Lay out / arrange this brainstorm" → **Gemini 3 Flash (minimal thinking)** or **Cerebras gpt-oss-120B**.
2. **Edit needs to *see* the canvas/keyframes → Tier 2 Haiku 4.5** (multimodal + robust tools).
3. **Offline / privacy flag → Tier 0 Apple on-device.**
4. **Spans many elements / needs planning / fast model's tool-call confidence low → escalate to Tier 3** (Claude Code over MCP), async.
5. **Keep one API surface:** Groq + Cerebras + DeepSeek(Anthropic-compat) + OpenAI are all OpenAI/Anthropic-compatible; Gemini via its SDK; Apple FM via Swift. Minimize branches — a single OpenAI-compatible client covers most of Tier 1.
6. **Do NOT wire the hot path to Codex-Spark** — no API, text-only, reportedly unreliable structured output. Watchlist only.

---

## 7. Confirmed vs reported vs rumored — ledger

- ✅ **Confirmed:** Spark still preview/Pro-only, no public API, 128k, text-only, >1000 tok/s on Cerebras. Groq deprecated llama-3.1-8b / llama-3.3-70b on 2026-06-17. Haiku 4.5 is the current fastest Haiku ($1/$5, 200k, multimodal, streaming tools). Gemini 3 Flash GA Dec 17 2025 ($0.50/$3, thinking levels, structured-output+tools fusion). Gemini 3.1 Flash-Lite ($0.25/$1.50, 1M, 359 tok/s, 5.6s TTFT reasoning-on). DeepSeek V4 Flash (Apr 24 2026, 1M, tool calls/JSON, Anthropic-compat). Cerebras structured outputs + streaming + tools. Apple FM `@Generable` typed streaming (WWDC26).
- 🟡 **Reported:** exact TTFT/tok/s figures (Artificial Analysis/vendor, load-dependent). Spark's SWE-Bench Pro ~56% and "shaky tool/JSON formatting." Cerebras ~3,000 tok/s gpt-oss-120B / ~2,000 Llama Scout. Groq gpt-oss-20B ~955–1000 tok/s. Haiku TTFT 0.58–0.78s. MiniMax M2.7 ~435 tok/s on SambaNova.
- 🔶 **Rumored / unsettled:** Spark public API + price (none; CometAPI reseller "~80% of OpenAI" unpriced). "Claude Haiku 4.6" (does not exist — disregard). Whether Gemini 3 Flash's tools+structured-output text-leak bug is fully fixed (open report). Exact Cerebras per-model retail prices.

**Action items:** (1) Re-check Spark API monthly — but treat its *structured-output reliability* as the real gate, not just availability. (2) Before committing Gemini 3 Flash to the hot path, reproduce the tools+JSON-schema text-leak test. (3) Migrate any existing Groq Llama-3.x usage to `gpt-oss-20b`/`gpt-oss-120b`/`qwen3.6-27b` before deprecation hits.

---

## Sources

- [GPT-5.3-Codex-Spark — OpenAI](https://openai.com/index/introducing-gpt-5-3-codex-spark/)
- [OpenAI GPT-5.3-Codex-Spark Powered — Cerebras](https://www.cerebras.ai/blog/openai-codexspark)
- [GPT-5.3 Codex Spark Review 2026 — RockB/baeseokjae](https://baeseokjae.github.io/posts/gpt-5-3-codex-spark-review-2026/)
- [What is GPT-5.3-Codex-Spark? How to Use it — CometAPI](https://www.cometapi.com/what-is-gpt-5-3-codex-spark-how-to-use-it/)
- [GPT 5.3 Codex API Pricing 2026 — PricePerToken](https://pricepertoken.com/pricing-page/model/openai-gpt-5.3-codex)
- [Pricing — Codex | OpenAI Developers](https://developers.openai.com/codex/pricing)
- [Claude Haiku 4.5 — API Provider Performance & Price | Artificial Analysis](https://artificialanalysis.ai/models/claude-4-5-haiku/providers)
- [Claude 4.5 Haiku — Intelligence, Performance & Price | Artificial Analysis](https://artificialanalysis.ai/models/claude-4-5-haiku)
- [5 LLM APIs Tested for Latency: Real Data 2026 — Kunal Ganglani](https://www.kunalganglani.com/blog/llm-api-latency-benchmarks-2026)
- [Current Claude Model Version: Opus 4.8, Sonnet 4.6, Haiku 4.5 (June 2026) — Tygart Media](https://tygartmedia.com/current-claude-model-version/)
- [Models overview — Claude API Docs](https://platform.claude.com/docs/en/about-claude/models/overview)
- [Introducing Gemini 3 Flash — Google Blog](https://blog.google/products/gemini/gemini-3-flash/)
- [Gemini 3 Flash — Intelligence, Performance & Price | Artificial Analysis](https://artificialanalysis.ai/models/gemini-3-flash)
- [Gemini 3.1 Flash-Lite — Intelligence, Performance & Price | Artificial Analysis](https://artificialanalysis.ai/models/gemini-3-1-flash-lite-preview)
- [Gemini 3.1 Flash Lite: most cost-effective — Google Blog](https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-3-1-flash-lite/)
- [JSON Schema support in Gemini API — Google Blog](https://blog.google/innovation-and-ai/technology/developers-tools/gemini-api-structured-outputs/)
- [Gemini 3 Pro/Flash output internal JSON as text when tools provided — vercel/ai #11396](https://github.com/vercel/ai/issues/11396)
- [Supported Models — GroqDocs](https://console.groq.com/docs/models)
- [Model Deprecation — GroqDocs](https://console.groq.com/docs/deprecations)
- [Groq On-Demand Pricing — Groq](https://groq.com/pricing)
- [Groq API Pricing (June 2026) — AI Pricing Guru](https://www.aipricing.guru/groq-pricing/)
- [Structured Outputs — Cerebras Inference Docs](https://inference-docs.cerebras.ai/capabilities/structured-outputs)
- [Cerebras Inference](https://www.cerebras.ai/inference)
- [Cerebras Pricing: 2,000 tok/s Inference — Morph](https://www.morphllm.com/cerebras-pricing)
- [DeepSeek V4 Flash — Intelligence, Performance & Price | Artificial Analysis](https://artificialanalysis.ai/models/deepseek-v4-flash)
- [DeepSeek V4 Flash — OpenRouter](https://openrouter.ai/deepseek/deepseek-v4-flash)
- [LLM API Providers (2026): 12 APIs Compared — Morph](https://www.morphllm.com/llm-api)
- [Fastest LLM Inference APIs in 2026: TTFT and Throughput — Inworld](https://inworld.ai/resources/fastest-llm-inference-api)
- [What's new in the Foundation Models framework — WWDC26](https://developer.apple.com/videos/play/wwdc2026/241/)
