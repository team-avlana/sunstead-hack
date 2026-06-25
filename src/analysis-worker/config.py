import os
from pathlib import Path

# Required for per-video worker
VIDEO_ID = os.environ.get("VIDEO_ID", "")
DB_CONNECTION_STRING = os.environ.get("DB_CONNECTION_STRING", "")

# Required for style-profile builder
CREATOR_ID = os.environ.get("CREATOR_ID", "")

# Anthropic API — direct key (preferred) or Azure AI Foundry
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
AZURE_ANTHROPIC_URL = os.environ.get("AZURE_ANTHROPIC_URL", "")
AZURE_ANTHROPIC_KEY = os.environ.get("AZURE_ANTHROPIC_KEY", "")

# LLM model names (override via env if Azure deployment names differ)
LLM_PER_SHOT_MODEL = os.environ.get("LLM_PER_SHOT_MODEL", "claude-haiku-4-5")
LLM_VIDEO_LEVEL_MODEL = os.environ.get("LLM_VIDEO_LEVEL_MODEL", "claude-sonnet-4-6")
LLM_SYNTHESIS_MODEL = os.environ.get("LLM_SYNTHESIS_MODEL", "claude-sonnet-4-6")

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


def llm_enabled() -> bool:
    """True if any Anthropic credential set is available."""
    return bool(ANTHROPIC_API_KEY or (AZURE_ANTHROPIC_URL and AZURE_ANTHROPIC_KEY))


def validate_profile_env() -> None:
    missing = [
        v for v in ("CREATOR_ID", "DB_CONNECTION_STRING") if not os.environ.get(v)
    ]
    if missing:
        raise RuntimeError(f"Missing required env vars: {', '.join(missing)}")
    if not llm_enabled():
        raise RuntimeError(
            "No Anthropic credentials found. Set ANTHROPIC_API_KEY "
            "or both AZURE_ANTHROPIC_URL and AZURE_ANTHROPIC_KEY."
        )


def validate_env() -> None:
    missing = [v for v in ("VIDEO_ID", "DB_CONNECTION_STRING") if not os.environ.get(v)]
    if missing:
        raise RuntimeError(f"Missing required env vars: {', '.join(missing)}")
    if not llm_enabled():
        print(
            "WARNING: No Anthropic credentials found — LLM metrics will be skipped. "
            "Set ANTHROPIC_API_KEY or both AZURE_ANTHROPIC_URL and AZURE_ANTHROPIC_KEY."
        )
