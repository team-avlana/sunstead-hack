# Pipeline Feasibility & Caveats Register (download → scene-detect → keyframes → VLM)

_Last updated: 2026-06-24_

A rigorous, honest feasibility and risk review of Rainy's local video pipeline. This **builds on** (does not duplicate) the two implementation references:
- `video-download-pipeline.md` — the yt-dlp download stage (format strings, cookies, per-platform notes, output layout).
- `scene-analysis-pipeline.md` — PySceneDetect → keyframes → VLM routing (detectors, `save_images`, FM-vs-Claude routing).

This doc answers a different question: **what could make this impractical or get the product in trouble**, with current (June 2026, post-WWDC 2026) numbers, plus a cost/perf model and a caveats register (risk → severity → mitigation).

**Bottom line up front:** The compute/cost side is *fine* — scene detection is seconds-per-video, on-device FM analysis is free, and even cloud VLM at 50-video scale is single-digit dollars if you batch and screen on-device. **The dominant risk is legal/ToS, and it got materially worse in early 2026.** A January 2026 federal ruling (*Cordova v. Huneault*) held that ripping YouTube video via tools that bypass YouTube's "rolling cipher" can independently violate DMCA §1201 **regardless of fair use**. That reframes a bundled downloader from "ToS gray area" to "potential anti-circumvention exposure." The defensible product is **bring-your-own-file / user's-own-content**, not a one-click third-party-URL ripper. Everything below quantifies the rest.

---

## 1. yt-dlp reliability & breakage cadence (per platform)

yt-dlp is healthy as an *engine* — daily commits, near-daily nightly releases, multiple active maintainers, 1800+ sites. The problem is **extractor drift**: platforms change their internals and individual extractors break, often without warning. Confirmed picture as of mid-2026:

### YouTube — was "most robust," now structurally harder (confirmed)
- **SABR / PO tokens are the big 2025–2026 shift.** YouTube removed playback URLs from `adaptiveFormats` for the `web` client, leaving only **SABR (Server-Based Adaptive Bit Rate)** — a proprietary streaming protocol — and is **enforcing PO (Proof-of-Origin) Tokens** for GVS playback on more clients. This is tracked across multiple open issues (#12482 `web` only has SABR formats; #13037 sabr=1 for YT Music; #13968 SABR forced even with `--cookies`; #14390 SABR forced even with premium cookies + PO token provider; #15793 SABR + missing JS runtime → "Only images available"). **Reported/ongoing**, not a one-off.
- Practical effect: the simple "paste URL, get mp4" path increasingly needs a **PO Token provider** (a plugin / external `bgutil` provider that runs a JS runtime to mint tokens) and/or alternate `player_client` (ios, tv, web_safari). This is *operational surface Rainy would have to babysit*, not a set-and-forget.
- Datacenter/VPN IPs get "Sign in to confirm you're not a bot" challenges; residential IP + browser cookies help but aren't guaranteed.

### TikTok — works but visibly fragile (confirmed)
- A long string of "Unable to extract webpage video data" breakages through 2025–2026: issues #12959, #14410 (2025.09.23), #14434, #14508, #14859, #15506, #15629. Pattern: TikTok rotates its web API, the extractor breaks, a fix lands days later in nightly. **Expect intermittent multi-day outages.**
- CAPTCHA challenge pages appear under load (#9418), which throttling/serialization mitigates but cannot eliminate.

### Instagram — most fragile, most login-walled (reported)
- Increasingly requires authenticated cookies even for public Reels; anonymous access rate-limits fast and the extractor is among the most frequently broken. Highest enforcement risk of the three (Meta).

### What this means for Rainy
- **Do not promise reliability you can't keep.** Any "download from URL" feature for YouTube/TikTok/Instagram is **best-effort** and will have visible failure windows. If a core user flow *depends* on a successful download, that flow will be broken for some users on some days.
- Engineering tax: you must (a) pin a recent yt-dlp and ship an **auto-update-to-nightly** path, (b) optionally bundle/run a **PO-token provider** for YouTube, (c) build clear, honest failure UX ("this platform changed; updating extractor…"), and (d) keep `gallery-dl` as a TikTok/Instagram fallback. This is ongoing maintenance, not one-time.

---

## 2. Legal / ToS exposure (the real risk) — what's defensible vs not

> Not legal advice. This summarizes the current public legal landscape so the product can be scoped defensibly.

### The thing that changed: *Cordova v. Huneault* (N.D. Cal., 5:25-cv-04685; order Jan 23, 2026)
- Magistrate Judge Virginia K. DeMarchi **denied a motion to dismiss** a DMCA §1201(a) anti-circumvention claim against a YouTuber who used "ripping" tools to download another creator's footage. Holding: *"Cordova has adequately pled that YouTube applies technological measures, including 'rolling-cipher technology' designed to prevent unauthorized downloading… that effectively control access… Whether the videos may be viewed by the public is immaterial."* (TorrentFreak, Slashdot, Eric Goldman blog, CaseMine all confirm.)
- **Two load-bearing consequences:**
  1. **Circumvention is a *separate* violation from infringement.** Even if the *use* of the footage is fair use, **bypassing the rolling cipher to obtain it can independently violate §1201.** Fair use is not a defense to anti-circumvention.
  2. This lowers the bar for a content owner to sue a *tool/competitor*, not just a re-uploader.
- **Status / how confirmed:** This is a **motion-to-dismiss denial**, not a final merits judgment or damages award — the case proceeds to discovery. So: *the theory survived and is now live precedent-in-the-making in N.D. Cal.* (confirmed), but the ultimate outcome and damages are **not yet decided** (do not overstate it). DMCA §1201 statutory damages can run **$200–$2,500 per act of circumvention** (17 U.S.C. §1203(c)(3)(A)), with willful/commercial exposure higher and potential criminal liability under §1204 for willful commercial circumvention — that's the *statutory framework*, not anything awarded in this case yet.

### Layer on the platform ToS (unchanged, also adverse)
- **YouTube ToS** prohibit downloading except via features YouTube provides (Premium offline). **TikTok ToS** prohibit scraping/downloading outside the in-app save feature. **Meta/Instagram ToS** prohibit automated downloading/scraping (highest enforcement appetite).
- Note: bypassing technical measures (the §1201 issue above) is a *statutory* problem layered **on top of** these contractual ToS problems.

### What's defensible vs not (practical scoping)
| Posture | Defensibility |
|---|---|
| User analyzes **their own uploaded file** (drag-drop local mp4) | **Most defensible.** No circumvention, no scraping, user owns/licensed the content. This is the safe core. |
| User analyzes **their own** YouTube/TikTok channel via login + own session | Defensible-ish; still technically downloads, but it's the user's content. |
| Transformative **analysis/metadata** of a third-party video the user lawfully accessed | Fair-use-leaning *for the analysis output*, **but** the act of bypassing the cipher to get the file is the §1201 exposure — analysis being transformative does **not** cure circumvention. |
| **One-click "paste any YouTube/TikTok URL → download"** as a bundled headline feature | **Least defensible** post-*Cordova*. This is exactly the "ripping tool that bypasses rolling cipher" pattern the court let proceed. Highest product/legal risk if Rainy ships and markets it. |

### How comparable shipping tools handle it (confirmed pattern)
- **Opus Clip, CapCut, Descript** — the obvious comparables — **do not bundle a third-party downloader.** They take **user-uploaded files or the user's own connected accounts**, and push copyright responsibility to the user via ToS. Opus Clip's policy is explicit: violating someone else's copyright is against its ToS and clips may face DMCA takedown. CapCut leans on its own licensed music library + a TikTok-oriented copyright checker. **None of them market "rip any URL."** That is the industry's revealed-preference answer to this exact risk.
- The standalone "URL ripper" category (the yt-dlp GUIs, online downloaders) is precisely the category now under §1201 pressure — and they're typically anonymous/offshore, not VC-backed shipping products with a company behind them.

### Recommendation for Rainy (product-shaping, not just a caveat)
1. **Make "import your own file" the first-class, default path.** It removes the entire §1201/ToS problem for the safe majority of use.
2. **If you keep URL download at all,** treat it as a power-user / "your own content" feature: require the user to authenticate as the content owner where possible, surface the ToS + §1201 reality in-product, never bundle credentials, and **don't make it the marketed hero**. The hero is the *infinite canvas / analysis*, not the ripper.
3. **Never ship/operate a PO-token-minting or cipher-bypass component as a headline capability** — that's the part most legible as "circumvention." If YouTube download requires actively defeating SABR/PO tokens, that's a strong signal to *not* make it a core, marketed flow.
4. Keep a clear **DMCA/abuse posture** (takedown contact, no hosting of others' media, on-device by default) so Rainy looks like an analysis tool, not a piracy tool.

---

## 3. Compute cost & time: scene detection (confirmed numbers)

Scene detection is **not** a bottleneck. From the official PySceneDetect benchmark (BBC = long-form, AutoShot/ClipShots = short clips), **wall-clock per video**:

| Detector | BBC (long-form) | AutoShot (short) | ClipShots (short) |
|---|---|---|---|
| ThresholdDetector | 16.05 s | — | — |
| HistogramDetector | 22.29 s | — | — |
| HashDetector | 25.51 s | 4.14 s | — |
| **AdaptiveDetector** (Rainy default) | **36.12 s** | **3.52 s** | **1.81 s** |
| ContentDetector | 37.02 s | 4.80 s | 2.52 s |

- These are at strict frame-exact tolerance with no aggressive optimization. **With Rainy's recommended knobs the numbers drop hard:**
  - **`auto_downscale`**: default downscale is 2 (SD), 4 (720p), 6 (1080p), **12 (4K)** — and each downscale increment is ~**4× faster**. Detecting on a downscaled frame barely affects cut accuracy.
  - **`frame_skip=1`** processes 50% of frames (~2× faster); `frame_skip=2` ~33%; trade a little boundary precision.
  - **Cap source at 720p at download time** (per the download doc) so you never decode 4K. A 4K decode is the expensive part, not the detection math.
- **Realistic expectation:** a typical 5–15 min social/competitor video at 720p with `auto_downscale` + AdaptiveDetector detects in **single-digit to low-tens of seconds** on Apple silicon. A long 4K film is the worst case (tens of seconds even downscaled) — but Rainy shouldn't be downloading 4K films.

**UI/sidecar blocking:** detection is CPU-bound and **single-video sequential**. It must run as a **cancellable background job in the Python sidecar** with progress streamed to Swift (PySceneDetect exposes `show_progress` / progress callbacks) — never on the main thread, never blocking the canvas. With that, it does not block the UI. PyAV backend (`open_video(path, backend='pyav')`) is faster and more codec-robust than OpenCV for long files. Cache the `StatsManager` CSV so threshold re-tuning doesn't re-decode.

**Splitting clips is the expensive step, and you usually don't need it.** `split_video_ffmpeg` default **re-encodes** (libx264, crf 22) for frame-accurate cuts — that's a full transcode pass. For VLM analysis you only need keyframes (`save_images`), so **skip splitting** unless the product surfaces per-scene clips; if you must split, stream-copy (`-c:v copy -c:a copy`).

---

## 4. VLM cost model at scale (the question that decides architecture)

### Inputs / assumptions
- Workload: **50 competitor videos × ~30 scenes = 1,500 scenes**.
- Keyframes: **3 per scene** (start/mid/end) is the doc's default → **4,500 frames**. (A cheaper mode is 1 frame/scene → 1,500 frames.)
- Batch policy: send **all 3 keyframes of a scene in ONE request** (multi-image message), not 3 requests. So **1,500 VLM calls**, not 4,500.

### Claude vision token math (confirmed formula, June 2026)
- Claude tokenizes images in **28×28 px patches**: `tokens = ⌈width/28⌉ × ⌈height/28⌉` visual tokens.
- Native-resolution caps: **1568 tokens / 1568 px long edge** for Haiku 4.5 and Sonnet 4.6; **4784 tokens / 2576 px** for Opus 4.7/4.8. Larger images are downscaled to fit (so 4K costs the same as 1080p after downscale).
- Reference point from Anthropic's docs: a **1092×1092 image = 1521 tokens**.
- **Rainy should cap keyframes at ~768–1024 px long edge before sending** (per the analysis doc). A 1024×576 (16:9) frame ≈ `37 × 21 = 777` visual tokens. Use **~800 input tokens per frame** as the planning figure.

### Per-request and per-job cost (Haiku 4.5 = the right tier for captioning)
Per scene request (3 frames + a shared system/instruction prompt + output caption):
- Images: 3 × ~800 = **~2,400 input tokens**
- Prompt/system (cached): ~600 tokens → **~60 effective tokens** with cache read (0.1×), or fully cached across the batch
- Output (per-scene JSON caption/tags): ~250 output tokens
- Haiku 4.5 pricing: **$1.00 / MTok input, $5.00 / MTok output**.

**Per scene:** ~2,460 in × $1/M = **$0.00246** + 250 out × $5/M = **$0.00125** ≈ **$0.0037/scene**.

| Scenario | Scenes | Tier | Standard API | Batch API (−50%) |
|---|---|---|---|---|
| **1 video** (~30 scenes) | 30 | Haiku 4.5 | **~$0.11** | **~$0.055** |
| **50 videos** (1,500 scenes) | 1,500 | Haiku 4.5 | **~$5.50** | **~$2.75** |
| **100 videos** (3,000 scenes) | 3,000 | Haiku 4.5 | **~$11** | **~$5.50** |
| 100 videos, **Sonnet 4.6** ($3/$15) | 3,000 | Sonnet | **~$31** | **~$15** |
| 100 videos, 1 frame/scene, Haiku, batch | 3,000 | Haiku | — | **~$2.5** |

Plus a **whole-video synthesis** call per video (feed the per-scene captions as text, ~few-K tokens, Sonnet/Opus): pennies to ~$0.02 each → **~$1–$2 per 100 videos**. So a heavy-analysis 100-video run on cloud is **~$5–$15 all-in** with Haiku captioning + occasional Sonnet synthesis + batch + prompt caching. **This is not a scary number** — but it's per-run and recurring, and a power user doing this weekly across many competitor sets adds up.

### On-device FM (free) is the default; cloud is the escalation
- Apple Foundation Models v3 (WWDC 2026) adds **image-in-prompt** via the `Attachment` API (`Prompt { "Caption this"; Attachment(image) }`), built-in **OCR (30+ languages)** and **barcode** tools, runs **on-device on Apple silicon, free, offline, no per-token cost.**
- **So the cost-optimal architecture is exactly the doc's routing:** do per-frame screening + per-scene tagging/captioning **on-device with FM (free)**, and escalate to **Claude vision only** for (a) scenes the user explicitly wants deep analysis on, (b) tasks FM is weak at (detailed OCR beyond the built-in tool, multi-frame narrative reasoning, polished prose), or (c) whole-video synthesis. Done this way, the 50-video run is **mostly $0**, with cloud spend only on the handful of escalated scenes.

**Caveat:** the cost model is benign **only if you screen on-device first.** If a naive implementation sends every frame to Claude with no caching/batching (4,500 separate Haiku calls, full-res, per 50 videos), you waste ~3× on duplicate per-call prompt overhead and lose the batch discount — still only ~$15–20, but it scales linearly and looks worse on Sonnet/Opus. The architecture (cache shared prompt, batch, 3-frames-per-call, on-device screen) is what keeps it cheap.

---

## 5. On-device FM v3 image throughput (realistic frames/min)

This is the **softest number** in the doc — Apple did **not publish per-image latency or tokens/sec for image analysis** in the WWDC 2026 sessions (237 "image understanding", 241 "what's new in Foundation Models"). What's confirmed and what we can estimate:

- **Confirmed:** on-device model context is **8,192 tokens** (PCC tier 32,000). Generation rate is **~30 tokens/sec on iPhone 15/17 Pro**. Images are accepted at "any size/aspect ratio" but **larger images consume more tokens and more latency** (Apple's own caveat — no number).
- **Mac is faster than phone** (memory-bandwidth bound): general local LLM inference runs ~**20–35 tok/s on M1**, **50–80 tok/s on M4** for comparable model sizes. FM's on-device model uses Instruction-Following Pruning so it doesn't load all weights — actual FM throughput on Mac is **not published**, but it's reasonable to expect it lands **north of the 30 tok/s phone figure on M-series Macs.**
- **Estimate (mark as estimate, verify empirically):** a single keyframe caption ≈ image-encode + prefill + ~50–150 output tokens. Treat each frame analysis as **~1–4 seconds** on an M-series Mac for a short caption/tag job. That's roughly **15–60 frames/min**, or **~10–40 min for 1,500 frames** if run purely sequentially.
  - This is **wall-clock for a big backlog, run in the background** — totally fine for "analyze my competitor set overnight / while I work," **not** fine for "interactive, instant per-frame." So: **FM for bulk/background, on-device, free**; reserve **Claude (faster wall-clock at volume via parallel cloud requests + batch)** when the user wants a large set analyzed *now*.
  - Image encoding cost matters: **downscale frames to ~768 px** before FM too (smaller image = fewer tokens = faster), per the analysis doc.
- **You MUST benchmark this on target hardware before committing UX promises.** Run a 100-frame timing pass on an M1 and an M4 in the sidecar/Swift harness; the published numbers don't exist, so empirical is the only honest source. (Caveat flagged in §7.)

---

## 6. Storage footprint & retention (confirmed bitrate numbers)

Downloaded video is the real disk consumer (analysis artifacts are tiny by comparison).

**Per-minute file size (confirmed):**
- **1080p ≈ 37.5 MB/min** at ~5 Mbps; YouTube's own recommended 1080p is 8–12 Mbps → **~60–90 MB/min**.
- **720p ≈ ~half** of 1080p → **~15–25 MB/min**.
- 4K at 35–68 Mbps is **~260–510 MB/min** — avoid by capping at 720p.

**Worked footprint (Rainy default = 720p cap):**
| Library size | Avg length | @720p (~20 MB/min) | @1080p (~50 MB/min) |
|---|---|---|---|
| 50 videos | 8 min | **~8 GB** | **~20 GB** |
| 100 videos | 8 min | **~16 GB** | **~40 GB** |
| 500 videos | 8 min | **~80 GB** | **~200 GB** |

- **Keyframes are negligible:** 3 JPEGs/scene × 30 scenes × ~60 KB ≈ **~5 MB/video**; `.info.json`, captions, `analysis.json` are KBs. So **the source media is ~99% of footprint.**
- **The video is only needed transiently** — for scene detection + keyframe extraction. After analysis, the keyframes + metadata + analysis JSON are the durable value; the source mp4 is the big, legally-spicy, re-downloadable blob.

**Retention strategy (recommendation):**
1. **Cap at 720p by default** (download doc already recommends this) — halves footprint vs 1080p and cuts decode/VLM cost.
2. **"Analyze then evict" mode (recommended default for third-party content):** after keyframes + analysis are persisted, **delete the source mp4** (keep `.info.json` so it's re-downloadable/repairable via `load_info_filename`). This **shrinks footprint to ~5 MB/video** *and* reduces legal exposure (you're not hosting others' media at rest — strong posture given §2). Keep the user's *own* uploads if they want.
3. **LRU/size-budget cache:** let the user set a library cap (e.g. 20 GB); evict least-recently-touched source media first, never evicting analysis artifacts.
4. Store under `~/Library/Application Support/Rainy/library/<extractor>/<id>/` per the download doc; make eviction a per-video reversible action (re-download from `.info.json`).
5. Surface footprint in settings ("Library: 12.4 GB across 84 videos — [Free up space]").

---

## 7. CAVEATS REGISTER (risk → severity → mitigation)

Severity: **Critical** = could sink/cripple the product or carry legal liability; **High** = breaks core flows / real cost; **Medium** = degrades UX / maintenance tax; **Low** = minor.

| # | Risk | Severity | Confidence | Mitigation |
|---|---|---|---|---|
| 1 | **DMCA §1201 anti-circumvention exposure** for bundled YouTube ripping (post-*Cordova v. Huneault*). Fair use does **not** cure circumvention. | **Critical** | Confirmed (MTD denied; merits/damages pending) | Make "import your own file" the default hero path. Don't market a URL ripper. Don't ship a cipher-bypass/PO-token component as a headline feature. Scope URL download to user-owned content + explicit consent + ToS disclosure. Get real counsel before shipping any third-party download. |
| 2 | **Platform ToS violation** (YouTube/TikTok/Instagram all prohibit downloading/scraping). Account/IP bans, takedowns, reputational. | **High** | Confirmed | Same as #1: user-own-content posture, no bundled credentials, on-device by default, takedown/abuse contact. Match the Opus Clip/CapCut/Descript "upload your own file" model. |
| 3 | **YouTube SABR/PO-token enforcement** breaks the simple download path; needs a JS-runtime PO-token provider to keep working. | **High** | Confirmed/ongoing (multiple open issues) | Auto-update yt-dlp to nightly; optionally bundle/run a PO-token provider; alternate `player_client` (ios/tv/web_safari); honest "platform changed" failure UX. Accept that this flow has outage windows. |
| 4 | **TikTok/Instagram extractor breakage** (recurring multi-day outages; CAPTCHA under load; IG login-walled). | **High** | Confirmed (issue stream through 2026) | Pin fresh yt-dlp + auto-nightly; `gallery-dl` fallback; throttle hard + serialize per platform (download doc §6); never promise reliability; clear retry/failure UX. |
| 5 | **Chrome cookie extraction unreliable** (App-Bound encryption); auth flows fail silently. | **Medium** | Confirmed | Guide users to Safari/Firefox or manual `cookies.txt`; never bundle cookies; surface auth failures clearly; sandboxed builds can't read other apps' cookie DBs (Developer-ID distribution baseline). |
| 6 | **Naive VLM fan-out cost** (every frame → separate full-res cloud call) inflates spend & latency. | **Medium** | Confirmed (pricing/formula known) | On-device FM screen first; 3-frames-per-request; prompt-cache shared system prompt; Batch API (−50%); Haiku tier for captioning; downscale to ~768–1024 px; reserve Sonnet/Opus for synthesis. |
| 7 | **On-device FM image throughput is unknown/unpublished** — could be too slow for "instant" UX on older Macs. | **Medium** | Reported/estimated (Apple published no per-image latency) | Benchmark on M1 + M4 before promising UX. Use FM for **background/bulk**, cloud for **interactive-at-volume**. Downscale frames. Cap on-device concurrency. Make backend a per-job policy. |
| 8 | **Storage bloat** from retained source video (16 GB/100 videos @720p; 200 GB/500 @1080p). | **Medium** | Confirmed (bitrate math) | 720p cap default; "analyze-then-evict" source mp4 (keep `.info.json`); LRU size-budget cache; show footprint + "free up space." |
| 9 | **4K decode blocking** scene detection / sidecar if 4K ever downloaded. | **Low** | Confirmed | 720p cap at download; `auto_downscale` + `frame_skip`; PyAV backend; background cancellable job, never on main thread. |
| 10 | **Frames leave device** when escalating to Claude (third-party footage to a cloud vendor) — consent/ToS implications. | **Medium** | Confirmed | Per-job "local-only / auto / cloud" policy surfaced in settings; never silently send footage to cloud; default on-device. |
| 11 | **Model-ID / pricing drift** (Anthropic ships new models/prices frequently — Opus 4.8, Sonnet 4.6, Haiku 4.5, Fable 5 all current 2026). | **Low** | Confirmed | Verify model IDs/prices via the `claude-api` skill before wiring; don't hardcode prices in UX; treat the cost table here as a snapshot. |
| 12 | **PySceneDetect 0.7 API drift** (some symbols moved `scene_manager`→`output`; 0.5 `VideoManager` deprecated). | **Low** | Confirmed | Use `open_video`/`SceneManager`; verify symbol locations against scenedetect.com before shipping (already flagged in the analysis doc). |

---

## 8. Rough cost/perf model (one-screen summary)

For a **50-competitor-video** analysis run (≈30 scenes/video, 3 keyframes/scene, 720p):

| Stage | Per video | Per 50 videos | Notes |
|---|---|---|---|
| **Download** (yt-dlp, 720p) | ~30 MB–160 MB, seconds–1 min | ~8 GB | best-effort; platform-dependent reliability |
| **Scene detect** (Adaptive + auto_downscale, 720p) | **~3–20 s** | **~3–15 min** (sequential, background) | not a bottleneck; never blocks UI |
| **Keyframe extract** (`save_images`, 3/scene, 768px) | <5 s | minutes | ~5 MB JPEGs/video |
| **Analysis — on-device FM** (default) | **$0**, ~10–60 s/video (est.) | **$0**, ~10–40 min background (est.) | free, private, offline; throughput unverified |
| **Analysis — Claude escalation** (Haiku, batched, cached) | **~$0.05–$0.11** | **~$2.75–$5.50** | only if escalating all scenes; usually far less |
| **Whole-video synthesis** (Sonnet/Opus, text) | ~$0.01–$0.02 | ~$0.50–$1 | optional |
| **Storage (retained)** | ~160 MB, or **~5 MB if evicted** | ~8 GB, or **~250 MB if evicted** | evict source mp4 after analysis |

**Headline:** compute and cost are **comfortably feasible** — a full cloud-analyzed 100-video run is **~$5–$15**, and the on-device-default path is **~$0** at the cost of background wall-clock time. **The blocker is not money or compute; it's the legal/ToS posture of bundled third-party downloading.** Ship the analysis hero on a **bring-your-own-file** foundation and the whole pipeline becomes both cheap *and* defensible.

---

## Sources

- yt-dlp `web` only has SABR formats (issue #12482): https://github.com/yt-dlp/yt-dlp/issues/12482
- yt-dlp PO Token Guide (wiki): https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide
- yt-dlp SABR forced with cookies (issue #13968): https://github.com/yt-dlp/yt-dlp/issues/13968
- yt-dlp SABR forced with premium cookies + PO token (issue #14390): https://github.com/yt-dlp/yt-dlp/issues/14390
- yt-dlp sabr=1 for YT Music (issue #13037): https://github.com/yt-dlp/yt-dlp/issues/13037
- "Bypassing the 2026 YouTube Great Wall" (SABR/PO-token context): https://dev.to/ali_ibrahim/bypassing-the-2026-youtube-great-wall-a-guide-to-yt-dlp-v2rayng-and-sabr-blocks-1dk8
- yt-dlp TikTok breakage issues: #14410 https://github.com/yt-dlp/yt-dlp/issues/14410 , #14508 https://github.com/yt-dlp/yt-dlp/issues/14508 , #15506 https://github.com/yt-dlp/yt-dlp/issues/15506 , #15629 https://github.com/yt-dlp/yt-dlp/issues/15629 , #9418 (CAPTCHA) https://github.com/yt-dlp/yt-dlp/issues/9418
- yt-dlp Ultimate Guide 2026 (update cadence, nightly): https://www.devkantkumar.com/blog/yt-dlp-ultimate-guide-2026/
- Cordova v. Huneault — TorrentFreak coverage: https://torrentfreak.com/ripping-clips-for-youtube-reaction-videos-can-violate-the-dmca-court-rules/
- Cordova v. Huneault — Slashdot: https://news.slashdot.org/story/26/02/05/1924252/court-rules-that-ripping-youtube-clips-can-violate-the-dmca
- Cordova v. Huneault — Eric Goldman Tech & Marketing Law Blog: https://blog.ericgoldman.org/archives/2026/01/it-takes-a-lot-for-512f-claims-to-survive-a-motion-to-dismiss-cordova-v-huneault.htm
- Cordova v. Huneault — CaseMine (5:2025cv04685, N.D. Cal.): https://www.casemine.com/judgement/us/697862bd6dc0a92f9d64b489
- Cordova v. Huneault — court order PDF: https://business.cch.com/ipld/CordovaHeneault20260123.pdf
- MediaNama — third-party YouTube downloads legal risks after DMCA ruling: https://www.medianama.com/2026/02/223-dmca-ruling-third-party-youtube-downloads-legal-risks-creators/
- YouTube fair use (official): https://support.google.com/youtube/answer/9783148?hl=en
- Opus Clip copyright content policy: https://help.opus.pro/docs/article/copyright-content-policy
- CapCut vs Descript vs Opus Clip (comparable-tools posture): https://www.aihustleguy.com/blog/descript-vs-capcut-vs-opus-clip-ai-video-editor
- PySceneDetect benchmark (per-video timing by detector): https://github.com/Breakthrough/PySceneDetect/blob/main/benchmark/README.md
- PySceneDetect CLI (downscale defaults 2/4/6/12, frame-skip behavior): https://www.scenedetect.com/cli/
- Anthropic pricing (Haiku 4.5 $1/$5, Sonnet 4.6 $3/$15, Opus 4.8 $5/$25, Batch −50%, prompt caching): https://platform.claude.com/docs/en/about-claude/pricing
- Anthropic vision docs (28×28 patch token formula, 1568/4784-token caps, 1092×1092=1521 tokens, 100 imgs/request): https://platform.claude.com/docs/en/docs/build-with-claude/vision
- Apple WWDC 2026 — What's new in image understanding (session 237): https://developer.apple.com/videos/play/wwdc2026/237/
- Apple WWDC 2026 — What's new in the Foundation Models framework (session 241): https://developer.apple.com/videos/play/wwdc2026/241/
- Apple Foundation Models framework docs: https://developer.apple.com/documentation/FoundationModels
- Apple Foundation Models WWDC 2026 (multimodal, Python SDK, fm CLI): https://byteiota.com/apple-foundation-models-wwdc-2026-multimodal-python-sdk/
- Apple Silicon local LLM tok/s benchmarks (M1 vs M4): https://modelpiper.com/blog/local-llm-benchmarks-apple-silicon
- Video file size per minute (1080p ~37.5 MB/min; YouTube recommended bitrates): https://toolstud.io/video/filesize.php
- YouTube recommended upload encoding/bitrates (official): https://support.google.com/youtube/answer/1722171?hl=en
- Internal: `architecture-patterns/video-download-pipeline.md`, `architecture-patterns/scene-analysis-pipeline.md`, `ai-on-device/foundation-models-v3.md`, `models/realtime-fast-models.md`, `architecture-patterns/python-sidecar-in-mac-app.md`, `architecture-patterns/persistence-shared-store.md`
