"""
Creator Room — IMAGE mode (the default).

Produces a single clay-render isometric diorama *image* of the creator's room,
1:1 with the reference style, including a stylized character/avatar. Flow:

    profile ──▶ build a vivid image prompt (optionally refined by Claude)
            ──▶ OpenAI gpt-image-1 renders the PNG
            ──▶ returned as a data URL the UI shows as the hero.

Anthropic only outputs text/code, so the *paint* step uses an image model
(gpt-image-1). Claude's role here is optional prompt-craft (used only when
ANTHROPIC_API_KEY is present); the deterministic prompt below stands on its own,
so image mode needs just OPENAI_API_KEY.
"""

from __future__ import annotations

import os
from typing import Any

IMAGE_MODEL = "gpt-image-1"


class ImageGenerationError(RuntimeError):
    """Raised when image generation can't run (no key) or the API fails."""


# --- shooter phrasing ------------------------------------------------------
_SHOOTER = {
    "iphone": "an iPhone on a small phone tripod",
    "dslr": "a DSLR camera on a tripod",
    "mirrorless": "a professional mirrorless camera on a tripod",
    "webcam": "a webcam clipped to a monitor",
    "podcast": "a podcast microphone on a boom arm",
}


def _join(xs: list[str] | None, n: int, default: str = "") -> str:
    xs = [str(x).strip() for x in (xs or []) if str(x).strip()]
    return ", ".join(xs[:n]) if xs else default


def build_prompt(profile: dict) -> str:
    """Fill the reference-faithful image prompt from the profile (deterministic)."""
    c = profile.get("creator", {}) or {}
    lib = profile.get("library", {}) or {}
    ct = profile.get("content", {}) or {}
    st = profile.get("style", {}) or {}
    cp = profile.get("companions", {}) or {}

    name = (c.get("name") or "a creator").strip()
    niche = (c.get("niche") or "content creation").strip()
    vibe = _join(c.get("vibe"), 3, "cozy, warm, minimal")

    reads = _join(lib.get("reads"), 4, "well-loved books")
    shows = _join(lib.get("shows"), 2, "favorite films")
    roles = _join(lib.get("roleModels"), 2, "small figurines")
    interests = _join(lib.get("interests"), 4, "photography and design")

    shooter = _SHOOTER.get(ct.get("shooter", ""), "a camera on a tripod")
    gear = _join(ct.get("gear"), 4, "a softbox light and a microphone")
    app = (ct.get("editingApp") or "a video editor").strip()

    palette = _join(st.get("palette"), 4, "warm cream, terracotta, sage")
    lighting = (st.get("lighting") or "warm").strip()
    materials = (st.get("materials") or "wood and linen").strip()
    pet = (cp.get("pet") or "cat").strip()
    props = _join(cp.get("props"), 3, "a latte mug and headphones")

    pet_clause = "" if pet == "none" else f"a sleeping {pet} curled up for warmth, "

    return (
        "Isometric 3D cutaway room, soft clay-render / 3D illustration style, cozy "
        "miniature diorama, 45-degree isometric camera, two visible walls meeting at "
        "a back corner, warm wood-plank floor, soft ambient occlusion and gentle "
        "studio shadows, rounded soft shapes, Pixar-like soft 3D, ultra detailed. "
        "Single room floating centered on a plain cream/off-white background. "
        "NO text, NO labels, NO arrows, NO captions.\n\n"
        f"This is the room of {name}, a content creator in {niche}; overall vibe: {vibe}. "
        "In the room a friendly stylized clay CHARACTER (the creator) sits in a comfy "
        "lounge chair wearing over-ear headphones, working on a laptop — a cute, warm, "
        "approachable 3D avatar with simple rounded features.\n\n"
        f"BACK WALL (library): floating wooden shelves with books ({reads}), framed "
        f"posters of {shows}, small figurines ({roles}), trailing plants, and niche "
        f"objects for {interests}.\n"
        f"FLOOR (content setup): {shooter}, plus {gear}, and a round wooden table with a "
        f"laptop whose screen shows {app} as a colorful editing timeline; recognizable, "
        "realistic creator gear.\n"
        "WINDOW WALL (lifestyle): a curtained window with a city view at dusk, a "
        "record player / speaker, a labeled gear box, and a small bookshelf.\n\n"
        f"STYLE: color palette {palette}; {lighting} lighting; {materials} materials; a "
        f"patterned woven rug; {pet_clause}signature props ({props}). "
        "RICH, VARIED COLORS — full-color illustration, NOT monochrome and NOT sepia: a "
        "cream linen sofa, a terracotta patterned kilim rug, colorful book spines, green "
        "leafy plants, warm honey wood floor, a white pendant lamp, and soft pastel "
        "accents alongside the palette. "
        "Centered composition, high detail, plain off-white background, no text."
    )


def _refine_with_claude(base: str, profile: dict) -> str:
    """Optionally let Claude tighten the prompt. No-op without ANTHROPIC_API_KEY."""
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return base
    try:
        import anthropic

        client = anthropic.Anthropic()
        msg = client.messages.create(
            model="claude-opus-4-8",
            max_tokens=1200,
            output_config={"effort": "low"},
            system=(
                "You write prompts for the gpt-image-1 model. Rewrite the user's draft "
                "into one vivid, concrete paragraph (max ~1100 characters) that preserves "
                "every specific object and the isometric clay-diorama style, keeps the "
                "stylized character/avatar, and ends with 'no text, no labels'. Output only "
                "the prompt — no preamble, no quotes."
            ),
            messages=[{"role": "user", "content": base}],
        )
        text = "".join(
            getattr(b, "text", "") for b in msg.content if getattr(b, "type", None) == "text"
        ).strip()
        return text or base
    except Exception:
        return base  # prompt-craft is best-effort; the deterministic prompt is solid


def generate_room_image(profile: dict) -> dict:
    """Render the room image. Returns {image (data URL), prompt, model}."""
    if not os.environ.get("OPENAI_API_KEY"):
        raise ImageGenerationError("OPENAI_API_KEY is not set on the Comms Service")
    try:
        from openai import OpenAI
    except ImportError as exc:  # pragma: no cover
        raise ImageGenerationError("the `openai` package is not installed") from exc

    prompt = _refine_with_claude(build_prompt(profile), profile)
    size = os.environ.get("RAINY_IMAGE_SIZE", "1536x1024")
    quality = os.environ.get("RAINY_IMAGE_QUALITY", "medium")  # low | medium | high

    try:
        client = OpenAI()
        resp = client.images.generate(model=IMAGE_MODEL, prompt=prompt, size=size, quality=quality, n=1)
        b64 = resp.data[0].b64_json
    except Exception as exc:
        raise ImageGenerationError(f"image generation failed: {exc}") from exc

    if not b64:
        raise ImageGenerationError("image model returned no image data")
    return {"image": "data:image/png;base64," + b64, "prompt": prompt, "model": IMAGE_MODEL}
