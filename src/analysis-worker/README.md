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

### LLM analysis (Azure AI Foundry → Anthropic)

| Variable | Description |
|---|---|
| `AZURE_ANTHROPIC_URL` | Azure AI Foundry endpoint URL for Anthropic models |
| `AZURE_ANTHROPIC_KEY` | Azure AI Foundry API key |
| `LLM_PER_SHOT_MODEL` | Model for per-shot vision analysis (default: `claude-haiku-4-5-20251001`) |
| `LLM_VIDEO_LEVEL_MODEL` | Model for video-level synthesis (default: `claude-sonnet-4-6`) |

If `AZURE_ANTHROPIC_URL` or `AZURE_ANTHROPIC_KEY` is absent, LLM metrics are
skipped and the worker still completes with deterministic metrics only.

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
AZURE_ANTHROPIC_URL="https://..." \
AZURE_ANTHROPIC_KEY="..." \
python main.py
```

## Output

On success the worker writes:

- `videos.local_path`, `videos.title`, `videos.duration_sec`,
  `videos.published_at` — from yt-dlp metadata.
- `videos.metrics` (JSONB) — `{deterministic: {...}, llm: {...}, transcript: {...}}`.
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
