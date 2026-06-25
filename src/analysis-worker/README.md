# analysis-worker

Single-video analysis pipeline. Downloads, shot-splits, transcribes, computes
deterministic + LLM metrics, and writes everything to Postgres.

## Prerequisites

| Dependency | How to install |
|---|---|
| **ffmpeg** | `brew install ffmpeg` / `apt install ffmpeg` / [ffmpeg.org](https://ffmpeg.org/download.html) |
| **crispasr** | `pip install crispasr` or see [CrispStrobe/CrispASR](https://github.com/CrispStrobe/CrispASR) |
| Python 3.11+ | — |

## Install Python deps

```bash
pip install -r requirements.txt
```

> **Note on optional deps:** `mediapipe` (face detection) and `easyocr`
> (on-screen text) are included but will be skipped silently if they fail to
> import. Fall back to OpenCV Haar cascades for faces; OCR is skipped. This
> lets the pipeline run even if these heavier packages cause install friction.

## Environment variables

### Required

| Variable | Description |
|---|---|
| `VIDEO_ID` | UUID of an existing `videos` row to analyze |
| `DB_CONNECTION_STRING` | Postgres DSN, e.g. `postgresql://user:pass@localhost/db` |

### LLM analysis (choose one)

**Option A — Anthropic API (direct):**

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key from console.anthropic.com |

**Option B — Azure AI Foundry:**

| Variable | Description |
|---|---|
| `AZURE_ANTHROPIC_URL` | Azure AI Foundry endpoint URL for Anthropic models |
| `AZURE_ANTHROPIC_KEY` | Azure AI Foundry API key |

**Model selection (both options):**

| Variable | Default | Description |
|---|---|---|
| `LLM_PER_SHOT_MODEL` | `claude-haiku-4-5-20251001` | Per-shot vision analysis (runs N times) |
| `LLM_VIDEO_LEVEL_MODEL` | `claude-sonnet-4-6` | Video-level narrative synthesis (runs once) |

If no credentials are set, LLM metrics are skipped and the worker completes
with deterministic metrics only.

### CrispASR / transcription

> CrispASR is invoked as:
> ```
> crispasr --backend cohere --force-aligner --output <transcript.json> audio.wav
> ```
> Verify the exact flag names against the
> [CrispASR README](https://github.com/CrispStrobe/CrispASR) and use
> `CRISPASR_EXTRA_ARGS` to patch them if needed.

### Optional

| Variable | Description |
|---|---|
| `WORKDIR` | Base directory for downloaded files and frames (default: `tmp/`) |

## Running

```bash
VIDEO_ID=<uuid> \
DB_CONNECTION_STRING="postgresql://user:pass@localhost/db" \
ANTHROPIC_API_KEY="sk-ant-..." \
python main.py
```

## Output

On success the worker writes:

- `videos.local_path`, `videos.title`, `videos.duration_sec`,
  `videos.published_at` — from yt-dlp metadata.
- `videos.metrics` (JSONB) — `{deterministic: {...}, llm: {...}, transcript: {...}}`.
  Key LLM narrative fields: `hook_text`, `hook_opening_words`, `hook_format`,
  `hook_strength`, `hook_reasoning`, `tone_voice`, `tone_adjectives`,
  `speaking_style`, `topic`, `subtopics`, `audience_pain_point`,
  `value_proposition`, `narrative_arc`, `retention_tactics`,
  `overall_style_summary`.
- One `shots` row per detected shot with `frame_path` and `analysis` JSONB.
- `videos.analyzed_at = now()` — set last as the completion marker.

On failure:

- `videos.analysis_error` is set; `analyzed_at` remains NULL.

Re-running the same `VIDEO_ID` is safe (idempotent).

## File layout

```
main.py                  # entrypoint
config.py                # env parsing, model names, paths
db.py                    # Postgres helpers
download.py              # yt-dlp wrapper
scenes.py                # PySceneDetect shot detection
frames.py                # ffmpeg frame extraction
transcribe.py            # CrispASR wrapper + per-shot slicing
metrics_deterministic.py # frame stats, pacing, speech aggregates
analyze_llm.py           # Anthropic per-shot + video-level analysis
requirements.txt
workdir/                 # gitignored: downloads + extracted frames
```
