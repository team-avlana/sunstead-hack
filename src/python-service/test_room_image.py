"""Standalone test for room image generation.

Calls image_gen.generate(), saves the result to a local PNG — does NOT write
to the database.

Usage
-----
# Minimal (no DB frames — uses the test profile + no face reference):
  python test_room_image.py

# With a real creator so DB frames + style profile are pulled:
  python test_room_image.py --creator-id <uuid>

# Custom output path:
  python test_room_image.py --output ~/Desktop/my_room.png

# Override the deployment for a quick prompt-check (low quality):
  AZURE_OPENAI_DEPLOYMENT=dall-e-3 python test_room_image.py

Required env vars (or set them in src/python-service/.env):
  AZURE_OPENAI_URL        https://<resource>.openai.azure.com
  AZURE_OPENAI_KEY        <key>
  DB_CONNECTION_STRING    postgres://... (only needed when --creator-id is given)
"""

import argparse
import os
import sys
import time
from pathlib import Path

# ── ensure we can import the service modules from this directory ────────────
sys.path.insert(0, str(Path(__file__).resolve().parent))


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Test room image generation")
    p.add_argument(
        "--creator-id",
        default=os.getenv("CREATOR_ID"),
        help="UUID of an existing creator. When given, real DB frames + style profile "
        "are used. When omitted, the test profile below is used with no face frames.",
    )
    p.add_argument(
        "--output",
        default="room_image_test.png",
        help="Output file path (default: room_image_test.png)",
    )
    return p.parse_args()


# ---------------------------------------------------------------------------
# Rich test profile — mirrors the wizard inputs so the prompt is fully filled.
# ---------------------------------------------------------------------------
TEST_PROFILE = {
    "creator": {
        "name": "Dome",
        "niche": "tech & creative workflow",
        "vibe": ["minimal", "warm", "focused"],
    },
    "library": {
        "interests": ["photography", "coding", "coffee", "F1"],
        "reads": ["Deep Work", "Show Your Work", "Atomic Habits", "The Creative Act"],
        "shows": ["Chef's Table", "Formula 1: Drive to Survive"],
        "roleModels": ["Casey Neistat", "Peter McKinnon"],
    },
    "content": {
        "shooter": "mirrorless",
        "gear": ["softbox", "shotgun mic", "gimbal"],
        "editingApp": "Premiere Pro",
    },
    "referral": {
        "tech": [{"label": "My camera kit"}, {"label": "My desk setup"}],
        "lifestyle": [{"label": "My Spotify playlist"}],
    },
    "style": {
        "palette": ["#E8C9A0", "#C98A5E", "#8FA98C", "#D9B08C"],
        "lighting": "warm",
        "materials": "wood+linen",
    },
    "companions": {
        "pet": "cat",
        "props": ["latte mug", "headphones", "paper lantern"],
    },
}

# Fake UUID used when no --creator-id is given (DB queries return empty safely).
_STUB_UUID = "00000000-0000-0000-0000-000000000000"


def main() -> None:
    args = _parse_args()
    creator_id = args.creator_id or _STUB_UUID
    output = Path(args.output).expanduser().resolve()

    print(f"→ creator_id : {creator_id}")
    print(f"→ output     : {output}")
    print(
        f"→ profile    : {'from DB (style_profile table)' if args.creator_id else 'TEST_PROFILE (hardcoded)'}"
    )
    print()

    # Lazy import so config.py loads the .env first.
    import image_gen  # noqa: PLC0415

    if args.creator_id:
        # Real path — uses DB frames + style profile.
        profile = None  # let image_gen.py read from DB
    else:
        # No DB needed — inject the test profile; DB calls return empty gracefully.
        profile = TEST_PROFILE

    print("Calling gpt-image-1… (this usually takes 20–60 s)")
    t0 = time.perf_counter()
    try:
        png_bytes = image_gen.generate(creator_id, profile)
    except RuntimeError as exc:
        print(f"\n✗ Generation failed: {exc}")
        sys.exit(1)

    elapsed = time.perf_counter() - t0
    output.write_bytes(png_bytes)

    kb = len(png_bytes) / 1024
    print(f"\n✓  Done in {elapsed:.1f}s — {kb:.0f} KB written to {output}")
    print("   Open the file to inspect the result.")


if __name__ == "__main__":
    main()
