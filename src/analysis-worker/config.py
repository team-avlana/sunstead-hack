import os
from pathlib import Path

# Required
VIDEO_ID = os.environ.get("VIDEO_ID", "")
DB_CONNECTION_STRING = os.environ.get("DB_CONNECTION_STRING", "")

# Azure AI Foundry → Anthropic
AZURE_ANTHROPIC_URL = os.environ.get("AZURE_ANTHROPIC_URL", "")
AZURE_ANTHROPIC_KEY = os.environ.get("AZURE_ANTHROPIC_KEY", "")

# LLM model names (override via env if Azure deployment names differ)
LLM_PER_SHOT_MODEL = os.environ.get("LLM_PER_SHOT_MODEL", "claude-haiku-4-5")
LLM_VIDEO_LEVEL_MODEL = os.environ.get("LLM_VIDEO_LEVEL_MODEL", "claude-sonnet-4-6")

# Persistent outputs (downloaded video + extracted frames, referenced by DB)
WORKDIR = Path(os.environ.get("WORKDIR", "workdir"))
# Ephemeral processing files (audio.wav, audio.json — safe to delete after a run)
TMPDIR = Path(os.environ.get("TMPDIR", "tmp"))


def get_video_workdir(video_id: str) -> Path:
    d = WORKDIR / video_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def get_frames_dir(video_id: str) -> Path:
    d = get_video_workdir(video_id) / "frames"
    d.mkdir(parents=True, exist_ok=True)
    return d


def get_tmp_dir(video_id: str) -> Path:
    d = TMPDIR / video_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def validate_env() -> None:
    missing = [v for v in ("VIDEO_ID", "DB_CONNECTION_STRING") if not os.environ.get(v)]
    if missing:
        raise RuntimeError(f"Missing required env vars: {', '.join(missing)}")
    if not AZURE_ANTHROPIC_URL or not AZURE_ANTHROPIC_KEY:
        print(
            "WARNING: AZURE_ANTHROPIC_URL or AZURE_ANTHROPIC_KEY not set — LLM metrics will be skipped"
        )
