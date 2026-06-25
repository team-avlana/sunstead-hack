# Scene Analysis Pipeline (PySceneDetect → Frames → VLM) for Rainy

_Last updated: 2026-06-24_

Implementation reference for Rainy's **local analysis pipeline**: take a downloaded video (see `video-download-pipeline.md`), split it into scenes with **PySceneDetect**, extract representative **keyframes**, and route those frames to a **VLM** — either Apple Foundation Models on-device (free/private, see `ai-on-device/foundation-models-v3.md`) or **Claude vision** for heavier work (see `models/realtime-fast-models.md`). Runs in the Python sidecar (`python-sidecar-in-mac-app.md`).

> **Version note.** PySceneDetect **0.7** is current. The convenience `detect()` function, the `open_video` / `SceneManager` / `detect_scenes` flow, `ContentDetector` / `AdaptiveDetector` / `ThresholdDetector`, `split_video_ffmpeg`, and `save_images` are stable across 0.6.x→0.7. The 0.5-era `VideoManager` is **deprecated** — use `open_video`. Verify exact symbol locations (some moved from `scenedetect.scene_manager` into `scenedetect.output` in 0.7) against scenedetect.com before shipping.

---

## 1. Install

```bash
# OpenCV backend (default, simplest):
uv pip install --python ./PythonRuntime/venv "scenedetect[opencv]"
# headless servers / sidecar: opencv-python-headless is fine
# PyAV backend (faster, fewer decode quirks on some codecs):
# uv pip install "scenedetect[pyav]"
```

Requires **ffmpeg on PATH** for video splitting (`split_video_ffmpeg`). Rainy already bundles ffmpeg for yt-dlp — reuse it.

---

## 2. Detecting scenes — the quick path

```python
from scenedetect import detect, ContentDetector

# Returns a list of (start, end) FrameTimecode pairs:
scenes = detect("video.mp4", ContentDetector(threshold=27.0), show_progress=True)

for i, (start, end) in enumerate(scenes):
    print(
        f"Scene {i+1}: "
        f"{start.get_timecode()} → {end.get_timecode()} "      # 'HH:MM:SS.nnn'
        f"[frames {start.get_frames()}–{end.get_frames()}] "
        f"({(end - start).get_seconds():.2f}s)"
    )
```

`detect(video_path, detector, stats_file_path=None, show_progress=False, start_time=None, end_time=None, start_in_scene=False)`.

Each boundary is a **`FrameTimecode`** — extract:
- `.get_timecode()` → `"HH:MM:SS.nnn"` string
- `.get_frames()` → integer frame index
- `.get_seconds()` → float seconds
- subtract two (`end - start`) → duration as a `FrameTimecode`

If `scenes` is empty, the whole video is one scene (no cuts detected) — handle that as a single scene spanning 0 → end.

---

## 3. Detecting scenes — `SceneManager` (control + performance)

Use this when you need frame-skipping, downscaling, a stats file, or to reuse the opened video for keyframe extraction.

```python
from scenedetect import open_video, SceneManager, ContentDetector, StatsManager

def find_scenes(path: str, threshold: float = 27.0):
    video = open_video(path)                      # backend='opencv' (default) or 'pyav'
    stats = StatsManager()                        # optional: cache per-frame metrics
    sm = SceneManager(stats_manager=stats)
    sm.add_detector(ContentDetector(threshold=threshold))

    # --- performance knobs (see §6) ---
    sm.auto_downscale = True                      # auto-pick downscale from resolution
    # sm.downscale = 2                            # or force: process every 2nd column/row
    sm.detect_scenes(video=video, frame_skip=0, show_progress=True)

    scene_list = sm.get_scene_list()              # list[(FrameTimecode, FrameTimecode)]
    return video, scene_list, sm
```

- `get_scene_list()` returns the boundary pairs.
- Pass `start_time` / `end_time` to `detect_scenes` (or to `open_video` via seeking) to analyze a sub-range.
- A `StatsManager` lets you write/load a stats CSV (`stats.save_to_csv(...)`) so re-tuning the threshold doesn't re-decode the video.

### Detectors — which to use

| Detector | How it works | Use for | Key params |
|---|---|---|---|
| **`ContentDetector`** | Weighted HSV frame-to-frame delta; fires on **fast cuts**. The default, best general choice. | Most edited social videos (hard cuts). | `threshold` (default ~27; lower = more sensitive = more scenes), `min_scene_len` (frames), `weights`, `luma_only` |
| **`AdaptiveDetector`** | Rolling-average of content delta (HSL); robust to **fast camera motion / handheld** that would false-trigger ContentDetector. | Vlogs, action, shaky footage. | `adaptive_threshold` (default ~3.0), `min_scene_len`, `window_width`, `min_content_val` |
| **`ThresholdDetector`** | Average **frame brightness** vs a fixed threshold; detects **fades to/from black**. | Cinematic content with fade transitions. | `threshold` (0–255, default ~12), `fade_bias`, `method` (floor/ceiling) |

Also available in 0.7: `HistogramDetector` (HSV histogram correlation) and `HashDetector` (perceptual hash) — alternatives when Content/Adaptive misbehave on a clip.

**Recommendation for Rainy:** default to `AdaptiveDetector` for user-uploaded/social footage (handheld-tolerant); expose a "sensitivity" slider mapping to `adaptive_threshold` / `ContentDetector.threshold`, and a `min_scene_len` floor (e.g. 15 frames) to avoid micro-scenes.

---

## 4. Splitting into clips & saving keyframes

### Split the video into per-scene clips (ffmpeg)

```python
from scenedetect import split_video_ffmpeg

split_video_ffmpeg(
    input_video_path="video.mp4",
    scene_list=scene_list,
    output_dir="scenes/",
    output_file_template="$VIDEO_NAME-Scene-$SCENE_NUMBER.mp4",  # default template
    show_progress=True,
    # arg_override=...  # to tune ffmpeg flags; default re-encodes (crf 22, preset veryfast)
)
```

Default behavior **re-encodes** (libx264, crf 22) for frame-accurate cuts. For speed and if exact boundaries aren't critical, override to stream-copy:

```python
split_video_ffmpeg(
    "video.mp4", scene_list, output_dir="scenes/",
    arg_override="-map 0:v:0 -map 0:a? -c:v copy -c:a copy",  # fast, keyframe-aligned cuts
)
```

There is also `split_video_mkvmerge(...)` (faster, stream-copy, `.mkv` output) if mkvmerge is available.

> **For VLM analysis you usually do NOT need to physically split the video** — you only need representative frames (next section). Skip splitting unless the product surfaces per-scene clips to the user; it saves a lot of disk and re-encode time.

### Save representative frames per scene

```python
from scenedetect import save_images, open_video

video = open_video("video.mp4")
# returns {scene_index: [list of image file paths]}
image_map = save_images(
    scene_list=scene_list,
    video=video,
    num_images=3,                 # frames per scene: e.g. start / middle / end
    frame_margin=1,               # skip N frames in from each boundary (avoid transition blur)
    image_extension="jpg",
    encoder_param=90,             # JPEG quality
    image_name_template="$VIDEO_NAME-Scene-$SCENE_NUMBER-$IMAGE_NUMBER",
    output_dir="scenes/frames/",
    scale=None,                   # or e.g. 0.5 to downscale; or width/height args
    show_progress=True,
)
```

`num_images=3` with `frame_margin=1` gives a clean start/mid/end triptych per scene — a good default to feed a VLM (one frame can miss the point of a scene; three captures motion/change cheaply). For a **single** keyframe per scene, use `num_images=1` (grabs the scene midpoint), which is the cheapest VLM input.

### DIY keyframe extraction (full control)

When you want exactly the middle frame as a JPEG with no temp files, decode directly:

```python
import av  # PyAV

def extract_frame(path: str, frame_index: int, out_path: str):
    container = av.open(path)
    stream = container.streams.video[0]
    fps = float(stream.average_rate)
    target_sec = frame_index / fps
    container.seek(int(target_sec / stream.time_base), stream=stream)
    for frame in container.decode(stream):
        if frame.pts is not None and frame.pts * stream.time_base >= target_sec:
            frame.to_image().save(out_path, quality=85)   # PIL JPEG
            break
    container.close()
```

Or one-shot via ffmpeg (precise seek before input is fast):

```python
import subprocess
def ffmpeg_frame_at(path, seconds, out_path, max_w=768):
    subprocess.run([
        "ffmpeg", "-y", "-ss", str(seconds), "-i", path,
        "-frames:v", "1",
        "-vf", f"scale='min({max_w},iw)':-2",   # cap width for VLM, keep aspect
        "-q:v", "3", out_path,
    ], check=True)
```

**Downscale frames before the VLM** (cap longest side ~768–1024px). VLMs don't need full resolution, and smaller images mean fewer tokens / faster on-device inference.

---

## 5. VLM analysis routing

Two backends. **Route by job size and privacy, not by default to the cloud.**

### (a) Apple Foundation Models on-device — local, free, private
See `ai-on-device/foundation-models-v3.md`. AFM 3 supports **image-in-prompt** (`Attachment` / image in the prompt) on the rebuilt on-device model, runs locally on Apple silicon, **free and offline**, no per-token cost.

> **Beta flag:** AFM 3 image-in-prompt and the exact attachment API are WWDC 2026 / macOS 27 SDK surface and may shift before GA — verify symbol names against `developer.apple.com/documentation/FoundationModels`.

Good for:
- **High-volume, per-frame/per-scene tagging** where cost matters: "is this indoor/outdoor", "are there people", short captions, content tags, NSFW/quality screening.
- Anything privacy-sensitive (user's own unpublished footage stays on device).
- Structured output via `@Generable` guided generation → reliable per-scene JSON.

Limits: smaller model → weaker at nuanced/long-form reasoning, fine-grained OCR, or comparing many frames at once. Throughput bounded by local NPU; process scenes sequentially/in small concurrency.

This call lives on the **Swift side** (FoundationModels is a Swift framework), so the sidecar hands frame file paths back to Swift, which runs FM and writes results. Alternatively use Apple's **Private Cloud Compute** tier for bigger context, still keyless/free in beta.

### (b) Claude vision — heavier analysis
See `models/realtime-fast-models.md`. Use the Anthropic Messages API with image content blocks.

> Verify current model IDs/pricing via the `claude-api` skill before wiring — model IDs and prices change.

Good for:
- **Rich per-scene descriptions**, narrative/beat analysis, "what's happening and why it matters", OCR of on-screen text, brand/object identification, multi-frame reasoning (pass the 3 keyframes of a scene in one message and ask for one synthesized description).
- Whole-video summarization by feeding the per-scene keyframe set.

Tradeoffs:
- **Cost + latency + network**, and frames leave the device (consent/ToS implications for downloaded third-party content — flag to user).
- **Batch** aggressively: send all keyframes of a scene in **one** request (multiple image blocks) rather than one request per frame. Use the **Claude Batch API** (~50% cheaper) for non-interactive bulk analysis of a backlog, and **prompt caching** for the shared system prompt across scenes.
- Use a **fast/cheap tier** (e.g. a Haiku-class model) for per-scene captioning and reserve a stronger model for whole-video synthesis.

### Routing recommendation
1. **Default: on-device FM** for per-frame screening + per-scene tagging/captions (free, private, fast enough).
2. **Escalate to Claude vision** only for (a) scenes/videos the user explicitly wants deep analysis on, (b) tasks FM is weak at (detailed OCR, multi-frame reasoning, polished prose), or (c) whole-video synthesis.
3. Make the backend a **per-job policy** ("local only" / "auto" / "high-quality cloud") surfaced in settings; never silently send user footage to the cloud.

Image payload tips (both backends): cap longest side ~768–1024px, JPEG q≈85, 1–3 frames per scene. More than ~4–5 frames per request rarely improves description quality and inflates tokens/latency.

---

## 6. Performance tips for long videos

- **`frame_skip`** in `detect_scenes` (e.g. `frame_skip=1` or `2`) roughly halves/thirds decode work by analyzing every Nth frame. Trade-off: slightly less precise boundaries and **incompatible with a `StatsManager`/accurate stats** — fine for detection, not for fade-precise cuts.
- **`auto_downscale = True`** (or set `downscale` 2–4) — detection on a downscaled frame is far cheaper and barely affects cut accuracy. Big win on 4K.
- **Cap source resolution at download time** (720p, per the download doc) so you never decode 4K for analysis.
- **PyAV backend** (`open_video(path, backend='pyav')`) is often faster and more codec-robust than OpenCV for long files.
- **Cache the stats CSV** (`StatsManager.save_to_csv`) so re-running with a different threshold skips re-decoding.
- **Don't split clips** unless needed (§4) — keyframe extraction alone avoids a full re-encode pass.
- Run detection in the sidecar as a **background job** with progress (`show_progress` / progress callback) streamed to Swift; cancellable per-video.

---

## 7. Suggested end-to-end pipeline

```
download (yt-dlp, 720p cap)         → video.mp4 + info.json   [video-download-pipeline.md]
   │
   ▼
scene-detect (AdaptiveDetector,     → scene_list = [(start,end), ...]
   auto_downscale, frame_skip)
   │
   ▼
keyframe extract (save_images        → scenes/frames/scene-NNNN-{1,2,3}.jpg
   num_images=3, downscaled)
   │
   ▼
VLM describe per scene
   ├─ on-device FM (default): tag + caption each scene's keyframes  [foundation-models-v3.md]
   └─ Claude vision (escalation): rich description / OCR / synthesis [realtime-fast-models.md]
   │
   ▼
persist results → analysis.json + Rainy shared store  [persistence-shared-store.md]
```

### What to persist

**Per video**
`id`, `platform`/`extractor`, `source_url`, `title`, `uploader`, `duration`, `resolution`, `fps`, `local_path`, `downloaded_at`, `detector` + params used, `scene_count`, `analyzed_at`, optional whole-video summary, captions/transcript ref.

**Per scene** (`scenes[]`)
`scene_index`, `start_tc` / `end_tc` (timecode strings), `start_frame` / `end_frame`, `duration_s`, `keyframe_paths[]`, optional `clip_path`, `vlm_backend` used, `description`, `tags[]`, `ocr_text`, `objects[]`, `confidence`, `tokens`/`cost` (if cloud).

**Per frame** (if you keep frame-level results)
`frame_index`, `timecode`, `image_path`, `width`/`height`, `vlm_backend`, `caption`/`labels`.

Store boundaries as **both** timecode strings and frame numbers (frame numbers are exact and fps-independent for re-extraction; timecodes are human-readable and used for clip cutting). Keep the raw `.info.json` and `analysis.json` next to the media so the whole per-video folder is self-describing and re-importable.

---

## Sources

- PySceneDetect 0.7 API reference: https://www.scenedetect.com/docs/latest/api.html
- PySceneDetect documentation home: https://www.scenedetect.com/docs/latest/
- PySceneDetect CLI reference (detectors, split-video, save-images defaults): https://www.scenedetect.com/cli/
- PySceneDetect changelog (0.6.x → 0.7, crf default 22, save_images interpolation): https://www.scenedetect.com/changelog/
- PySceneDetect GitHub: https://github.com/Breakthrough/PySceneDetect
- PySceneDetect on PyPI: https://pypi.org/project/scenedetect/
- FFmpeg documentation (frame extraction / scale filter): https://ffmpeg.org/documentation.html
- PyAV documentation (decoding / seeking): https://pyav.org/docs/stable/
- Anthropic Messages API — vision / image content blocks: https://docs.anthropic.com/en/docs/build-with-claude/vision
- Anthropic Message Batches API: https://docs.anthropic.com/en/docs/build-with-claude/batch-processing
- Apple Foundation Models framework: https://developer.apple.com/documentation/FoundationModels
- Internal: `ai-on-device/foundation-models-v3.md`, `models/realtime-fast-models.md`, `architecture-patterns/python-sidecar-in-mac-app.md`, `architecture-patterns/persistence-shared-store.md`
