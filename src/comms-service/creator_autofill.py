"""
Creator Room — onboarding autofill.

The slick onboarding asks only a FEW questions (niche, vibe, name, pet). This
module expands that seed into a full `CreatorProfile` (the rest of the ~27 fields:
reads/shows/role-models/interests, gear/shooter/editing-app, referral links,
palette/lighting/materials, props) so the room is rich without a big form.

An LLM does the expansion (OpenAI gpt-4o-mini today, since that's the key we have;
Claude when ANTHROPIC_API_KEY is present). It is ALWAYS wrapped in a deterministic
fallback + coercion so onboarding can never dead-end on a bad/empty key or response.
The profile shape mirrors `CreatorProfile` in src/canvas-ui/lib/creatorRoom.ts.
"""

from __future__ import annotations

import json
import os
from typing import Any

SHOOTERS = {"iphone", "dslr", "mirrorless", "webcam", "podcast"}
LIGHTINGS = {"warm", "neutral", "moody", "bright"}
PETS = {"cat", "dog", "none"}

# Mirrors DEFAULT_PROFILE in creatorRoom.ts — the fallback + one-shot example.
DEFAULT: dict = {
    "creator": {"name": "Avlana", "niche": "tech & lifestyle vlogs", "vibe": ["cozy", "warm", "minimal"]},
    "library": {
        "interests": ["photography", "coffee", "travel", "design"],
        "reads": ["Deep Work", "Show Your Work", "Atomic Habits", "On Writing"],
        "shows": ["Chef", "Lost in Translation"],
        "roleModels": ["Casey", "Peter"],
    },
    "content": {"shooter": "mirrorless", "gear": ["softbox", "shotgun mic", "gimbal"], "editingApp": "Premiere Pro"},
    "referral": {
        "tech": [{"label": "My camera kit", "link": ""}],
        "lifestyle": [{"label": "My Spotify playlist", "link": ""}],
    },
    "style": {"palette": ["#E8C9A0", "#C98A5E", "#8FA98C", "#D9B08C"], "lighting": "warm", "materials": "wood+linen"},
    "companions": {"pet": "cat", "props": ["latte mug", "headphones", "paper lantern"]},
}

_SCHEMA_HINT = json.dumps(DEFAULT, indent=2)

_SYSTEM = (
    "You design a cozy isometric clay-diorama 'creator room' for a content creator. "
    "Given a niche + vibe + name + pet, invent a believable, specific, on-brand profile "
    "for that creator. Match every field to the niche and vibe (a fitness creator has "
    "different gear/reads/palette than a cooking creator). Keep it tasteful, not generic. "
    "Return ONLY a JSON object with EXACTLY this shape (same keys/types):\n" + _SCHEMA_HINT +
    "\nRules: shooter is one of iphone|dslr|mirrorless|webcam|podcast; lighting is one of "
    "warm|neutral|moody|bright; pet is one of cat|dog|none; palette is 3-4 hex colors that fit "
    "the vibe; arrays have 2-5 short items; referral links use the given label with an empty link. "
    "No commentary, no markdown — just the JSON."
)


def _as_list(v: Any) -> list:
    return v if isinstance(v, list) else []


def _links(v: Any, fallback: list) -> list:
    out = []
    for item in _as_list(v):
        if isinstance(item, dict) and item.get("label"):
            out.append({"label": str(item["label"]).strip(), "link": str(item.get("link") or "").strip()})
        elif isinstance(item, str) and item.strip():
            out.append({"label": item.strip(), "link": ""})
    return out or fallback


def _coerce(raw: dict, seed: dict) -> dict:
    """Build a valid CreatorProfile from (possibly partial/garbage) raw + seed + DEFAULT."""
    raw = raw if isinstance(raw, dict) else {}
    lib = raw.get("library") or {}
    ct = raw.get("content") or {}
    st = raw.get("style") or {}
    cp = raw.get("companions") or {}
    rf = raw.get("referral") or {}

    shooter = ct.get("shooter") if ct.get("shooter") in SHOOTERS else DEFAULT["content"]["shooter"]
    lighting = st.get("lighting") if st.get("lighting") in LIGHTINGS else DEFAULT["style"]["lighting"]
    palette = [p for p in _as_list(st.get("palette")) if isinstance(p, str) and p.strip()][:4] or DEFAULT["style"]["palette"]

    return {
        "creator": {"name": seed["name"], "niche": seed["niche"], "vibe": seed["vibe"]},
        "library": {
            "interests": _as_list(lib.get("interests")) or DEFAULT["library"]["interests"],
            "reads": _as_list(lib.get("reads")) or DEFAULT["library"]["reads"],
            "shows": _as_list(lib.get("shows")) or DEFAULT["library"]["shows"],
            "roleModels": _as_list(lib.get("roleModels")) or DEFAULT["library"]["roleModels"],
        },
        "content": {
            "shooter": shooter,
            "gear": _as_list(ct.get("gear")) or DEFAULT["content"]["gear"],
            "editingApp": str(ct.get("editingApp") or DEFAULT["content"]["editingApp"]).strip(),
        },
        "referral": {
            "tech": _links(rf.get("tech"), DEFAULT["referral"]["tech"]),
            "lifestyle": _links(rf.get("lifestyle"), DEFAULT["referral"]["lifestyle"]),
        },
        "style": {"palette": palette, "lighting": lighting, "materials": str(st.get("materials") or DEFAULT["style"]["materials"]).strip()},
        "companions": {"pet": seed["pet"], "props": _as_list(cp.get("props")) or DEFAULT["companions"]["props"]},
    }


def _user_prompt(seed: dict) -> str:
    return (
        f"niche: {seed['niche']}\nvibe: {', '.join(seed['vibe'])}\nname: {seed['name']}\npet: {seed['pet']}\n"
        "Invent the rest of this creator's room profile as JSON."
    )


def _openai_fill(seed: dict) -> dict | None:
    from openai import OpenAI

    client = OpenAI()
    resp = client.chat.completions.create(
        model=os.environ.get("RAINY_AUTOFILL_MODEL", "gpt-4o-mini"),
        response_format={"type": "json_object"},
        messages=[{"role": "system", "content": _SYSTEM}, {"role": "user", "content": _user_prompt(seed)}],
        temperature=0.8,
    )
    return json.loads(resp.choices[0].message.content)


def _anthropic_fill(seed: dict) -> dict | None:
    import anthropic

    client = anthropic.Anthropic()
    msg = client.messages.create(
        model="claude-opus-4-8",
        max_tokens=1500,
        output_config={"effort": "low"},
        system=_SYSTEM,
        messages=[{"role": "user", "content": _user_prompt(seed)}],
    )
    text = "".join(getattr(b, "text", "") for b in msg.content if getattr(b, "type", None) == "text").strip()
    start, end = text.find("{"), text.rfind("}")
    return json.loads(text[start : end + 1]) if start >= 0 else None


def autofill_profile(seed_in: dict) -> dict:
    """Expand {niche, vibe, name, pet} into a full CreatorProfile. Never raises."""
    seed = {
        "name": (str(seed_in.get("name") or "").strip() or "Creator"),
        "niche": (str(seed_in.get("niche") or "").strip() or "content creation"),
        "vibe": [str(v).strip() for v in _as_list(seed_in.get("vibe")) if str(v).strip()][:3] or ["cozy", "warm"],
        "pet": seed_in.get("pet") if seed_in.get("pet") in PETS else "cat",
    }
    raw: dict | None = None
    try:
        if os.environ.get("OPENAI_API_KEY"):
            raw = _openai_fill(seed)
        elif os.environ.get("ANTHROPIC_API_KEY"):
            raw = _anthropic_fill(seed)
    except Exception:
        raw = None  # any LLM failure -> deterministic fallback below
    return _coerce(raw or {}, seed)
