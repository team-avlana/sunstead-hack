"""Azure OpenAI gpt-image-1 room image generation for creators.

Flow:
1. Pull talking-head frames from the creator's analyzed videos (shows face + setup).
2. Load the bundled clay-diorama style reference (canvas-ui/public/creator-room/sample.png).
3. Build a text prompt from shot analysis + style profile + optional form profile.
4. Call gpt-image-1 via Azure AI Foundry with the style reference + frame images.
5. Return raw PNG bytes — the caller persists them to the creators row.
"""

from __future__ import annotations

import base64
import logging
from pathlib import Path
from typing import Any

from openai import AzureOpenAI

from config import settings
import db

logger = logging.getLogger(__name__)

# Bundled style reference — same sample shown blurred in the canvas before generation.
_SAMPLE_IMAGE = (
    Path(__file__).resolve().parent.parent
    / "canvas-ui" / "public" / "creator-room" / "sample.png"
)


# ---------------------------------------------------------------------------
# Client factory
# ---------------------------------------------------------------------------

def _client() -> AzureOpenAI:
    url = settings.image.azure_openai_url
    key = settings.image.azure_openai_key
    if not url or not key:
        raise RuntimeError(
            "AZURE_OPENAI_URL and AZURE_OPENAI_KEY must be set to generate room images."
        )
    return AzureOpenAI(
        azure_endpoint=url,
        api_key=key,
        api_version="2025-04-01-preview",
    )


# ---------------------------------------------------------------------------
# Prompt builder
# ---------------------------------------------------------------------------

def _build_prompt(creator_id: str, profile: dict[str, Any] | None) -> str:
    """Compose a generation prompt from DB analysis data + optional form profile."""
    parts: list[str] = [
        "A cozy, detailed isometric clay-style 3D diorama illustration of a content"
        " creator's home studio room. Soft warm lighting, rounded clay shapes, gentle"
        " ambient occlusion, pastel colour tones. The room feels personal and"
        " lived-in — a creative sanctuary.",
    ]

    # ── from shot analysis stored in DB ──────────────────────────────────────
    frames = db.get_creator_frames_for_room(creator_id, limit=3)
    subjects: list[str] = []
    env_notes: list[str] = []
    for frame in frames:
        analysis = frame.get("analysis") or {}
        llm: dict = analysis.get("llm") or analysis  # handles both schema variants
        if not isinstance(llm, dict):
            continue
        if subject := llm.get("subject", ""):
            subjects.append(subject)
        if notes := llm.get("composition_notes", ""):
            env_notes.append(notes)

    if subjects:
        parts.append(f"The creator: {'; '.join(subjects[:3])}.")
    if env_notes:
        parts.append(f"Room environment: {'; '.join(env_notes[:3])}.")

    # ── from style profile ───────────────────────────────────────────────────
    style = db.get_style_profile(creator_id)
    if style:
        if summary := style.get("summary", ""):
            parts.append(f"Creator style: {summary[:400]}.")
        prof: dict = style.get("profile") or {}
        if isinstance(prof, dict):
            if palette := prof.get("palette"):
                parts.append(f"Colour palette: {', '.join(str(c) for c in palette[:5])}.")
            if tone := prof.get("tone"):
                parts.append(f"Overall tone: {tone}.")
            if gear := prof.get("gear"):
                if isinstance(gear, list):
                    parts.append(f"Visible gear: {', '.join(str(g) for g in gear[:5])}.")

    # ── from canvas form profile (optional) ──────────────────────────────────
    if profile and isinstance(profile, dict):
        creator = profile.get("creator") or {}
        if name := creator.get("name", ""):
            parts.append(f"Creator name: {name}.")
        if niche := creator.get("niche", ""):
            parts.append(f"Content niche: {niche}.")
        if vibe := creator.get("vibe"):
            parts.append(f"Vibe: {', '.join(vibe[:4])}.")

        sty = profile.get("style") or {}
        if lighting := sty.get("lighting"):
            parts.append(f"Lighting mood: {lighting}.")
        if materials := sty.get("materials"):
            parts.append(f"Room materials: {materials}.")
        if palette := sty.get("palette"):
            parts.append(f"Wall/accent palette: {', '.join(palette[:4])}.")

        comp = profile.get("companions") or {}
        if (pet := comp.get("pet")) and pet != "none":
            parts.append(f"Include a {pet} somewhere in the room.")
        if props := comp.get("props"):
            parts.append(f"Signature props: {', '.join(props[:5])}.")

        lib = profile.get("library") or {}
        if reads := lib.get("reads"):
            parts.append(f"Books on shelves: {', '.join(reads[:4])}.")

        content = profile.get("content") or {}
        if shooter := content.get("shooter"):
            parts.append(f"Primary camera: {shooter}.")
        if gear := content.get("gear"):
            parts.append(f"Filming gear: {', '.join(gear[:4])}.")

    parts.append(
        "Render in an isometric clay diorama art style. No text overlays. High"
        " detail. Warm ambient light. Soft contact shadows."
    )
    return " ".join(parts)


# ---------------------------------------------------------------------------
# Generation entry point
# ---------------------------------------------------------------------------

def generate(creator_id: str, profile: dict[str, Any] | None = None) -> bytes:
    """Generate a room PNG for the given creator and return the raw bytes.

    Passes:
    - A text prompt built from DB analysis + optional form profile.
    - The bundled style reference image (sample.png) as a low-detail reference.
    - Up to 2 talking-head frames so the model can pick up face/environment context.
    """
    client = _client()
    prompt = _build_prompt(creator_id, profile)
    logger.info("Generating room image for creator %s (prompt: %d chars)", creator_id, len(prompt))

    # ── assemble reference images ─────────────────────────────────────────────
    reference_images: list[dict] = []

    # 1. Style reference (the clay-diorama sample)
    if _SAMPLE_IMAGE.exists():
        ref_b64 = base64.b64encode(_SAMPLE_IMAGE.read_bytes()).decode()
        reference_images.append({"type": "base64", "data": ref_b64, "detail": "low"})
    else:
        logger.warning("Style reference image not found at %s", _SAMPLE_IMAGE)

    # 2. Creator frames (face + environment context)
    frames = db.get_creator_frames_for_room(creator_id, limit=2)
    for frame in frames:
        frame_b64 = base64.b64encode(frame["data"]).decode()
        reference_images.append({"type": "base64", "data": frame_b64, "detail": "low"})

    # ── call the API ──────────────────────────────────────────────────────────
    kwargs: dict[str, Any] = {
        "model": settings.image.azure_openai_deployment,
        "prompt": prompt,
        "n": 1,
        "size": "1024x1024",
        "quality": "medium",
        "response_format": "b64_json",
    }
    if reference_images:
        kwargs["extra_body"] = {"reference_images": reference_images}

    try:
        result = client.images.generate(**kwargs)
    except Exception as exc:
        # Some Azure deployments don't support reference_images yet — retry without.
        if reference_images and "reference_images" in str(exc):
            logger.warning(
                "reference_images not supported on this deployment, retrying without: %s", exc
            )
            kwargs.pop("extra_body", None)
            result = client.images.generate(**kwargs)
        else:
            raise

    b64_data = result.data[0].b64_json  # type: ignore[union-attr]
    if not b64_data:
        raise RuntimeError("gpt-image-1 returned no image data")

    return base64.b64decode(b64_data)
