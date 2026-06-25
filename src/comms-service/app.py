"""
Rainy Comms Service — HTTP API for the canvas-ui (static export) and the macOS
WKWebView shell.

This is the server-side home for work the static client can't do itself: Postgres
reads, real-time pings, and live generation. Its first endpoint generates the
Creator Room with Claude. See docs/architecture.md and
knowledge-base/architecture-patterns/webview-shell-and-data-path.md.

Run (dev):  uvicorn app:app --reload --port 8787
The canvas-ui reaches it via NEXT_PUBLIC_COMMS_API_URL (e.g. http://localhost:8787/api).
"""

from __future__ import annotations

import logging
import os
from typing import Any

try:  # load a local .env if present (OPENAI_API_KEY, ANTHROPIC_API_KEY, …)
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:  # python-dotenv is optional
    pass

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from creator_image import IMAGE_MODEL, ImageGenerationError, generate_room_image
from creator_room import MODEL, GenerationError, generate_room_html

log = logging.getLogger("rainy.comms")
logging.basicConfig(level=logging.INFO)

app = FastAPI(title="Rainy Comms Service", version="0.1.0")

# CORS: the canvas-ui calls this cross-origin — from the dev web app
# (http://localhost:3000) and from the WKWebView custom scheme (app-resource://).
# Allow-list those origins via RAINY_ALLOWED_ORIGINS (comma-separated); default
# to "*" for local dev. Tighten in production.
_origins = os.environ.get("RAINY_ALLOWED_ORIGINS", "*")
allow_origins = ["*"] if _origins.strip() == "*" else [o.strip() for o in _origins.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


class GenerateBody(BaseModel):
    profile: dict[str, Any]


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "model": MODEL,
        "imageModel": IMAGE_MODEL,
        "generation": bool(os.environ.get("ANTHROPIC_API_KEY")),
        "image": bool(os.environ.get("OPENAI_API_KEY")),
    }


@app.post("/api/creator-room/image")
def image(body: GenerateBody) -> dict[str, Any]:
    """Render a clay-diorama IMAGE of the room for the posted profile (default mode)."""
    try:
        return generate_room_image(body.profile)
    except ImageGenerationError as exc:
        # 503: the UI falls back to the bundled sample image.
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:  # pragma: no cover
        log.exception("creator-room image generation failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/creator-room/generate")
def generate(body: GenerateBody) -> dict[str, Any]:
    """Generate a bespoke 3D Creator Room document (the alternative mode)."""
    try:
        return generate_room_html(body.profile)
    except GenerationError as exc:
        # 503: the UI falls back to its built-in procedural room.
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:  # pragma: no cover
        log.exception("creator-room generation failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", host="127.0.0.1", port=int(os.environ.get("PORT", "8787")), reload=True)
