"""Azure OpenAI image generation helpers.

generate()                  — Creator Room (gpt-image-1.5 via images.edit())
generate_storyboard_frame() — Storyboard panels for future video ideas (gpt-image-1-mini)

Key API facts (verified from official docs):
- images.generate() is TEXT-ONLY. To pass reference/input images use images.edit().
- images.edit() accepts up to 16 images via the `image` parameter (PNG/WebP/JPG, ≤50 MB each).
- GPT image models use `output_format` (png/jpeg/webp), NOT `response_format`.
  They always return base64; response_format does not exist on these models.
- `background="transparent"` is supported on gpt-image-1 / gpt-image-1.5 / gpt-image-1-mini.
  It is NOT supported on gpt-image-2 (returns 400).
- `style` (vivid/natural) is DALL-E 3 only — not supported on GPT image models.
- `quality` values for GPT models: low / medium / high (default: auto).
"""

from __future__ import annotations

import base64
import logging
from io import BytesIO
from pathlib import Path
from typing import Any

from openai import OpenAI

from config import settings
import db

logger = logging.getLogger(__name__)

# Bundled style reference — the clay-diorama sample shown blurred in the canvas.
_SAMPLE_IMAGE = (
    Path(__file__).resolve().parent.parent
    / "canvas-ui"
    / "public"
    / "creator-room"
    / "sample.png"
)


# ---------------------------------------------------------------------------
# Client factory
# ---------------------------------------------------------------------------


def _client() -> OpenAI:
    url = settings.image.azure_openai_url
    key = settings.image.azure_openai_key
    if not url or not key:
        raise RuntimeError(
            "AZURE_OPENAI_URL and AZURE_OPENAI_KEY must be set to generate room images."
        )
    return OpenAI(
        base_url=url,
        api_key=key,
    )


# ---------------------------------------------------------------------------
# Placeholder derivation helpers
# ---------------------------------------------------------------------------


def _derive_room_design(lighting: str, materials: str) -> str:
    """Map style profile lighting + materials to a room design descriptor."""
    lighting = (lighting or "").lower()
    materials = (materials or "").lower()
    if "moody" in lighting:
        return "Industrial loft"
    if "bright" in lighting:
        return "Bright Scandinavian"
    if "neutral" in lighting and ("concrete" in materials or "metal" in materials):
        return "Modern minimal"
    if "warm" in lighting and ("wood" in materials or "linen" in materials):
        return "Scandinavian warm wood"
    if "warm" in lighting:
        return "Cozy warm minimalist"
    return "Cozy warm minimalist"


_SETUP_MAP: dict[str, str] = {
    "iphone": ("a smartphone on a small tripod, a ring light, and a clip-on mic"),
    "webcam": ("a webcam mounted on a monitor, a ring light, and a USB microphone"),
    "podcast": (
        "a professional podcast microphone on a boom arm, a webcam, and acoustic foam panels"
    ),
    "mirrorless": (
        "a Sony FX3 cinema camera on a sturdy tripod with a gimbal nearby, "
        "an LED softbox panel, a shotgun mic on a boom arm, and a small field monitor"
    ),
    "dslr": (
        "a DSLR camera on a sturdy tripod, an LED panel light, "
        "a shotgun mic on a boom arm, and a small monitor"
    ),
}


def _derive_recording_setup(shooter: str, gear: list[str]) -> str:
    base = _SETUP_MAP.get((shooter or "").lower(), _SETUP_MAP["mirrorless"])
    if gear:
        extra = ", ".join(g for g in gear[:3] if g)
        return f"{base} (also visible: {extra})"
    return base


# ---------------------------------------------------------------------------
# Prompt builder
# ---------------------------------------------------------------------------


def _build_prompt(
    creator_id: str,
    profile: dict[str, Any] | None,
    frames: list[dict],
    has_avatar: bool = False,
) -> str:
    """Assemble the structured room prompt from DB analysis + optional form profile."""

    p = profile or {}
    creator = p.get("creator") or {}
    lib = p.get("library") or {}
    content = p.get("content") or {}
    sty = p.get("style") or {}
    comps = p.get("companions") or {}

    # ── extract environment detail from shot analyses ─────────────────────────
    env_notes: list[str] = []
    gear_from_shots: list[str] = []
    for frame in frames:
        analysis = frame.get("analysis") or {}
        llm: dict = analysis.get("llm") or analysis
        if not isinstance(llm, dict):
            continue
        if notes := llm.get("composition_notes", ""):
            env_notes.append(notes)
        # Some analyses surface visible gear / props
        if onscreen := llm.get("onscreen_text_purpose", ""):
            gear_from_shots.append(onscreen)

    # ── niche ─────────────────────────────────────────────────────────────────
    niche = creator.get("niche", "")
    if not niche:
        style_profile = db.get_style_profile(creator_id)
        if style_profile:
            prof = style_profile.get("profile") or {}
            if isinstance(prof, dict):
                niche = prof.get("topic") or prof.get("inferred_audience") or ""
    niche = niche or "content"

    # ── vibe ──────────────────────────────────────────────────────────────────
    vibe_list: list[str] = creator.get("vibe") or []
    if not vibe_list:
        style_profile = db.get_style_profile(creator_id)
        if style_profile:
            prof = style_profile.get("profile") or {}
            if isinstance(prof, dict):
                vibe_list = prof.get("tone_adjectives") or []
    vibe = (
        ", ".join(str(v) for v in vibe_list[:3]) if vibe_list else "cozy, warm, minimal"
    )

    # ── room design ───────────────────────────────────────────────────────────
    lighting = sty.get("lighting", "")
    materials = sty.get("materials", "")
    if not (lighting or materials):
        style_profile = db.get_style_profile(creator_id)
        if style_profile:
            prof = style_profile.get("profile") or {}
            if isinstance(prof, dict):
                lighting = prof.get("lighting") or ""
    room_design = _derive_room_design(lighting, materials)

    # ── library shelf ─────────────────────────────────────────────────────────
    books = ", ".join(str(b) for b in (lib.get("reads") or [])[:5])
    role_models = ", ".join(str(r) for r in (lib.get("roleModels") or [])[:3])
    shows_films = ", ".join(str(s) for s in (lib.get("shows") or [])[:3])

    # Interests: form profile + environment detail from facecam footage
    interests_list: list[str] = list(lib.get("interests") or [])[:5]
    if env_notes:
        # Append what the facecam footage actually shows — objects, surroundings
        interests_list.extend(env_notes[:2])
    interests = ", ".join(interests_list) if interests_list else ""

    # ── recording setup ───────────────────────────────────────────────────────
    all_gear = list(content.get("gear") or []) + gear_from_shots
    recording_setup = _derive_recording_setup(
        content.get("shooter", ""),
        all_gear,
    )

    # ── shelf content (empty-clause rule) ─────────────────────────────────────
    shelf_parts: list[str] = []
    if books:
        shelf_parts.append(f"{books} as colorful book spines")
    if interests:
        shelf_parts.append(f"small objects suggesting {interests}")
    if shows_films:
        shelf_parts.append(f"small framed posters of {shows_films}")
    if role_models:
        shelf_parts.append(f"tiny figurines of {role_models}")
    shelf_content = (
        ", ".join(shelf_parts) if shelf_parts else "a few books and small objects"
    )

    # ── avatar clause ─────────────────────────────────────────────────────────
    # Photo mode when we have an uploaded avatar or face frames; else description.
    if frames or has_avatar:
        avatar_clause = (
            "stylize the person in the attached reference photo as the clay character — "
            "keep their likeness (face, skin tone, hairstyle, glasses, clothing style), "
            "rendered in the same soft clay look as the rest of the scene"
        )
    else:
        desc = p.get("avatarDescription", "")
        if not desc:
            desc = "a person working at their desk"
        avatar_clause = f"a stylized clay character: {desc}"

    # ── companion & details ───────────────────────────────────────────────────
    pet = comps.get("pet", "none")
    props = comps.get("props") or []
    if pet and pet != "none":
        companion = f"a {pet} resting nearby"
    elif props:
        companion = f"{', '.join(str(x) for x in props[:2])} as personal touches"
    else:
        companion = "a few personal touches that fit the style"

    # ── assemble final prompt ─────────────────────────────────────────────────
    return (
        f"Isometric clay-render of a cozy {niche} creator's studio — a single small "
        f'indoor room shown as a 3/4 top-down CUTAWAY "dollhouse", soft 3D clay aesthetic: '
        f"rounded edges, matte surfaces, warm soft global illumination, gentle ambient occlusion "
        f"in the corners, a subtle tilt-shift miniature depth-of-field, transparent background "
        f"outside the room, perfectly centered, ultra-clean, no text. Always a warm, cozy "
        f"mood. The room is always indoors — ignore any outdoor scenery in the reference images.\n\n"
        f"FIXED LAYOUT — always include ALL of these, in these same areas:\n"
        f"• ROOM SHELL: two cream rounded walls meeting at the back + a light wooden-plank floor "
        f"and a soft rug, in a {room_design} style with a {vibe} feel.\n"
        f"• WINDOW (right-hand wall, ALWAYS present): a window with soft natural daylight spilling in.\n"
        f"• LIBRARY SHELF (back/left wall, ALWAYS in this same area): a wall-mounted wooden shelf "
        f"holding {shelf_content}, a potted plant, and a small brown REINDEER figurine "
        f'(the "Rainey" mascot).\n'
        f"• CONTENT RECORDING SETUP (floor, center-front, ALWAYS present): {recording_setup}, "
        f"facing the seat.\n"
        f"• AVATAR (seated at the recording setup, ALWAYS present, working/filming): {avatar_clause}.\n"
        f"• AMBIENT LIGHTS (ALWAYS present): a couple of style-matched lamps — e.g. a floor lamp "
        f"plus a pendant or table lamp — placed naturally; soft in this daytime render.\n"
        f"• COMPANION & DETAILS: {companion}, plus a few small personal touches that fit the style.\n\n"
        f"STYLE LOCK: keep the SAME isometric camera angle every time; one cohesive room; soft "
        f"warm shadows; miniature diorama feel. Absolutely NO text, letters, watermark, UI, or any "
        f"extra people beyond the single avatar. Square 1:1 aspect ratio."
    )


# ---------------------------------------------------------------------------
# Generation entry point
# ---------------------------------------------------------------------------


def generate(
    creator_id: str,
    profile: dict[str, Any] | None = None,
    avatar_photo: bytes | None = None,
    prompt: str | None = None,
) -> bytes:
    """Generate a room PNG for the given creator using images.edit().

    images.edit() is required (not images.generate()) because reference images
    are passed via the `image` parameter — images.generate() is text-to-image only.

    Passes up to 5 file inputs (style reference + an optional uploaded avatar
    photo + talking-head frames, one per distinct video) and a prompt.
    `avatar_photo` is the user's face uploaded in the Creator Room wizard; when
    present it anchors the clay character's likeness. `prompt`, when provided (the
    canvas wizard already builds a complete one), is used verbatim; otherwise the
    prompt is synthesised from `profile` + the creator's DB style profile. Either
    way the real talking-head frames are attached as references. Returns a PNG.
    """
    client = _client()

    # Fetch frames once — used for both prompt building and image inputs.
    frames = db.get_creator_frames_for_room(creator_id, limit=4)
    logger.info(
        "Generating room image for creator %s (%d frames from %d video(s), avatar=%s, prompt=%s)",
        creator_id,
        len(frames),
        len({f["video_id"] for f in frames}),
        bool(avatar_photo),
        "given" if prompt else "derived",
    )

    if not prompt:
        prompt = _build_prompt(
            creator_id, profile, frames, has_avatar=bool(avatar_photo)
        )
    logger.debug("Room prompt (%d chars): %s…", len(prompt), prompt[:120])

    # ── assemble image inputs for images.edit() ───────────────────────────────
    # images.edit() accepts Union[FileTypes, Sequence[FileTypes]] — we pass
    # tuples of (filename, file_obj, content_type) which the SDK serialises as
    # multipart form data.
    image_inputs: list[tuple[str, BytesIO, str]] = []

    if _SAMPLE_IMAGE.exists():
        image_inputs.append(
            ("sample.png", BytesIO(_SAMPLE_IMAGE.read_bytes()), "image/png")
        )
    else:
        logger.warning("Style reference not found at %s", _SAMPLE_IMAGE)

    # The uploaded face goes in right after the style reference so the model
    # treats it as the avatar likeness (the prompt's photo clause refers to it).
    if avatar_photo:
        image_inputs.append(("avatar.png", BytesIO(avatar_photo), "image/png"))

    for i, frame in enumerate(frames):
        ext = "jpg" if "jpeg" in frame["mime_type"] else "png"
        image_inputs.append(
            (f"frame_{i}.{ext}", BytesIO(frame["data"]), frame["mime_type"])
        )

    # ── API call ──────────────────────────────────────────────────────────────
    # GPT image models: use output_format (not response_format), quality low/medium/high.
    # gpt-image-1.5 supports background="transparent".
    common: dict[str, Any] = {
        "model": settings.image.azure_openai_deployment,
        "prompt": prompt,
        "n": 1,
        "size": "1024x1024",
        "quality": "medium",
        "output_format": "png",
        "background": "transparent",
    }

    if image_inputs:
        result = client.images.edit(image=image_inputs, **common)
    else:
        # No reference images available — fall back to text-to-image.
        logger.warning("No reference images available, falling back to images.generate()")
        result = client.images.generate(**common)

    b64_data: str | None = result.data[0].b64_json  # type: ignore[union-attr]
    if not b64_data:
        raise RuntimeError("gpt-image-1.5 returned no image data")

    return base64.b64decode(b64_data)


# ---------------------------------------------------------------------------
# Storyboard frame generation  (gpt-image-1-mini)
# ---------------------------------------------------------------------------


def generate_storyboard_frame(
    concept: str,
    *,
    shot_type: str = "medium shot",
    style_hints: dict[str, Any] | None = None,
    aspect_ratio: str = "16:9",
) -> bytes:
    """Generate a single storyboard panel PNG for a future video idea.

    Uses gpt-image-1-mini — fast and cheap, appropriate for thumbnail-sized
    planning images that will be shown in a grid, not printed large.

    Args:
        concept:      Scene description, e.g. "Creator sitting at a neon-lit desk,
                      reviewing analytics on a large monitor, late night".
        shot_type:    Cinematography framing hint passed into the prompt
                      (e.g. "close-up", "wide shot", "over-the-shoulder").
        style_hints:  Optional dict with keys like `lighting`, `palette`, `mood`
                      pulled from the creator's style profile.
        aspect_ratio: "16:9" (default, widescreen) or "1:1" (square).

    Returns:
        Raw PNG bytes of the storyboard panel.
    """
    client = _client()

    # ── map aspect_ratio to supported size ────────────────────────────────────
    size = "1792x1024" if aspect_ratio == "16:9" else "1024x1024"

    # ── build storyboard prompt ───────────────────────────────────────────────
    style_parts: list[str] = []
    if style_hints:
        if lighting := style_hints.get("lighting"):
            style_parts.append(f"{lighting} lighting")
        if mood := style_hints.get("mood"):
            style_parts.append(f"{mood} mood")
        if palette := style_hints.get("palette"):
            colors = ", ".join(str(c) for c in palette[:3])
            style_parts.append(f"colour palette {colors}")
    scene_context = ", ".join(style_parts) if style_parts else ""

    prompt = (
        f"Storyboard panel, {shot_type}: {concept}"
        + (f". Context: {scene_context}" if scene_context else "")
        + ". "
        "Hand-drawn pencil sketch on warm construction paper — rough hatching and "
        "cross-hatching for shadows, light paper texture showing through, loose "
        "expressive lines, no colour fills (monochrome graphite only), soft erased "
        "highlights. Uniform storyboard illustration style. No text, no UI overlays."
    )

    logger.info(
        "Generating storyboard frame (%s, %s): %s…", shot_type, size, concept[:80]
    )

    result = client.images.generate(
        model=settings.image.azure_openai_storyboard_deployment,
        prompt=prompt,
        n=1,
        size=size,
        quality="low",
        output_format="png",
    )

    b64_data: str | None = result.data[0].b64_json  # type: ignore[union-attr]
    if not b64_data:
        raise RuntimeError("gpt-image-1-mini returned no image data")

    return base64.b64decode(b64_data)
