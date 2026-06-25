"""
Creator Room generation — have Claude write a bespoke 3D room document.

The canvas-ui is a *static export* (no Node/Next server), so live generation runs
here in the Python Comms Service: the browser/WebView POSTs a creator profile, we
ask Claude (Opus 4.8) to generate a single self-contained three.js HTML document
for it, and we return that document. The UI renders it inside a sandboxed iframe.

Why a self-contained document (not React Three Fiber): R3F is the build-time path
for components baked into the app, but it cannot be transpiled and mounted into a
static client at runtime. A self-contained three.js doc, loaded via <iframe srcdoc>,
*is* runnable arbitrary generated code — and stays isolated from our origin.

Model/SDK choices follow the claude-api skill: Opus 4.8, adaptive thinking, and
streaming (large max_tokens would otherwise risk an HTTP timeout).
"""

from __future__ import annotations

import json
import os
import re
from typing import Any

MODEL = "claude-opus-4-8"


class GenerationError(RuntimeError):
    """Raised when generation can't run (no key) or the model output is unusable."""


SYSTEM_PROMPT = """\
You generate a single, self-contained, runnable 3D "Creator Room" web document
from a creator's JSON profile. The room is an isometric clay-render diorama (a
cozy cutaway room, two visible walls, wood floor, soft studio lighting) that
visualizes a content creator's world.

DESIGN CONTRACT — fixed skeleton + variable payload:
The geometry, the five named zones, the camera, and the lighting are CONSTANT;
only the OBJECTS inside each zone change per creator.
  - library    -> BACK WALL: shelves with books (recent reads), framed posters
                  (shows/films), small figurines (role models), plants, niche
                  artifacts from interests.
  - content    -> FLOOR CENTRE: the real shooting rig — a camera on a tripod sized
                  to content.shooter, plus content.gear, and a desk/table with a
                  laptop whose screen shows content.editingApp as an editing
                  timeline.
  - referral   -> SIDE / WINDOW WALL: a window, plus props implying the referral
                  links (a speaker/vinyl for a playlist, a labeled gear box).
  - style      -> WHOLE-ROOM FINISH: palette, lighting mood, materials.
  - companions -> SOFT PROPS: the pet, a cozy lamp, signature props (mug,
                  headphones, plant).

HARD REQUIREMENTS:
1. Output ONE complete HTML document and NOTHING else. Start at <!doctype html>.
   No markdown, no code fences, no commentary before or after.
2. Use three.js r0.169.0 ONLY, loaded via an importmap from jsDelivr (raw module
   files, so addons that `import "three"` resolve to the single instance):
     "three": "https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js"
     "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/"
   No other external assets — everything procedural (primitives + colors +
   CanvasTextures). It must run offline-of-assets (only the three.js CDN).
3. Use an OrthographicCamera for a true isometric look, with OrbitControls whose
   polar/azimuth range is limited so the viewer can't go behind the walls.
4. Five addressable groups: new THREE.Group() with .name set to exactly
   "library", "content", "referral", "style", "companions"; place each object
   into the correct group.
5. Every placed object carries mesh.userData = { zone, id, link }. Referral
   objects with a link are HOTSPOTS: on hover, highlight (emissive/scale); on
   click, call
     parent.postMessage({ source:'rainy-room', type:'hotspot', link, id, zone }, '*')
   When the scene is ready, also call
     parent.postMessage({ source:'rainy-room', type:'ready' }, '*')
6. Clay/soft look: MeshStandardMaterial, low metalness, mid-high roughness,
   rounded shapes (RoundedBoxGeometry from three/addons is available). Warm key
   DirectionalLight + soft ambient (HemisphereLight) + PCFSoft shadows. Derive
   palette and lighting from profile.style; default to a warm cozy diorama.
7. Respect prefers-reduced-motion: disable auto-rotate / idle motion when set.
8. Full-bleed canvas, white page background, handle resize. Robust to missing or
   empty profile arrays (guard everything).

Make it recognizable and warm — a real creator's room, readable per the profile.
"""

USER_TEMPLATE = """\
Generate the Creator Room document for this profile:

{profile}

Return ONLY the HTML document.
"""


def _client() -> Any:
    """Construct the Anthropic client, or raise GenerationError if unavailable."""
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise GenerationError("ANTHROPIC_API_KEY is not set on the Comms Service")
    try:
        import anthropic  # noqa: WPS433 (local import keeps startup light)
    except ImportError as exc:  # pragma: no cover
        raise GenerationError("the `anthropic` package is not installed") from exc
    return anthropic.Anthropic()


def _extract_html(text: str) -> str:
    """Strip stray markdown fences and any prose before the document."""
    text = text.strip()
    # Drop a leading ```html / ``` fence and its trailing partner if present.
    fence = re.match(r"^```[a-zA-Z]*\n(.*)\n```$", text, re.DOTALL)
    if fence:
        text = fence.group(1).strip()
    # Slice from the first <!doctype html> or <html ...> just in case.
    m = re.search(r"<!doctype html|<html", text, re.IGNORECASE)
    if m:
        text = text[m.start():]
    if "<html" not in text.lower() or "three" not in text.lower():
        raise GenerationError("model did not return a usable three.js document")
    return text


def generate_room_html(profile: dict) -> dict:
    """Generate a bespoke room document for `profile`. Returns {html, model}."""
    client = _client()
    user = USER_TEMPLATE.format(profile=json.dumps(profile, indent=2, ensure_ascii=False))

    # Stream: the document can be large, and large max_tokens on a non-streaming
    # request risks an HTTP timeout (see the claude-api skill).
    with client.messages.stream(
        model=MODEL,
        max_tokens=40000,
        thinking={"type": "adaptive"},
        output_config={"effort": "high"},
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user}],
    ) as stream:
        final = stream.get_final_message()

    if final.stop_reason == "refusal":
        raise GenerationError("the request was declined by the model")

    text = "".join(
        getattr(block, "text", "") for block in final.content if getattr(block, "type", None) == "text"
    )
    return {"html": _extract_html(text), "model": final.model}
