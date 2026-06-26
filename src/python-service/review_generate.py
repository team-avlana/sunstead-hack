"""Server-side UGC review generator — the agency dashboard's "Coach" step.

The canvas agent (Claude Code / Agent SDK) reasons the review by calling
compare_components + create_artifact. The dashboard is a non-agent surface, so it
needs the same reasoning as a single headless call: gather the delivery + brief +
reference, ask Claude (forced tool-use) for a structured verdict / per-dimension
scores / strengths / missing / Slack-ready coaching note, and persist it on the
review row. Scores persist so improvement-over-time can trend the creator.

Data shaping (the compact, comparison-ready view of a video) is reused from the
compare_components MCP tool so both surfaces diff the exact same signals.
"""

from __future__ import annotations

import os
import threading
import time

import db
import dev_events
from config import settings
from tools.review import _video_brief  # compact, comparison-ready video view

# Sonnet on Foundry/Anthropic (opus isn't deployed on our Foundry resource).
REVIEW_MODEL = os.environ.get("REVIEW_MODEL", "claude-sonnet-4-6")

# How long to wait for analysis before giving up on a review (deliveries are 1-3
# min each; a slow download + LLM pass can run longer).
_WATCH_TIMEOUT_SEC = 30 * 60
_WATCH_INTERVAL_SEC = 4


def _client():
    """Anthropic client mirroring the analysis-worker's provider routing: Azure
    Foundry when configured (drop inherited foundry env vars that conflict with an
    explicit base_url), else the direct Anthropic API."""
    azure_url = settings.llm.azure_anthropic_url
    azure_key = settings.llm.azure_anthropic_key
    anthropic_key = settings.llm.anthropic_api_key

    if azure_url and azure_key:
        from anthropic import AnthropicFoundry

        os.environ.pop("ANTHROPIC_FOUNDRY_RESOURCE", None)
        os.environ.pop("ANTHROPIC_FOUNDRY_BASE_URL", None)
        return AnthropicFoundry(base_url=azure_url, api_key=azure_key)
    if anthropic_key:
        import anthropic

        return anthropic.Anthropic(api_key=anthropic_key)
    raise RuntimeError(
        "No Anthropic credentials configured — set ANTHROPIC_API_KEY or both "
        "AZURE_ANTHROPIC_URL and AZURE_ANTHROPIC_KEY."
    )


_REVIEW_SCHEMA = {
    "type": "object",
    "properties": {
        "verdict": {
            "type": "string",
            "enum": ["approve", "revise", "reshoot"],
            "description": "approve = on-brief, ship it. revise = small fixes in "
            "edit/reshoot of a beat. reshoot = misses the brief, redo it.",
        },
        "overall_score": {
            "type": "integer",
            "description": "0-100 overall on-brief quality. Be consistent across "
            "deliveries so the trend is meaningful.",
        },
        "dimensions": {
            "type": "array",
            "description": "One entry per dimension you assessed. Always include "
            "hook, tone, pacing, and reference (use reference even with no reference "
            "video — score adherence to the brief's intent). Add constraints when the "
            "brief specifies on-screen text / CTA / must-says.",
            "items": {
                "type": "object",
                "properties": {
                    "key": {
                        "type": "string",
                        "enum": ["hook", "tone", "pacing", "reference", "constraints"],
                    },
                    "label": {"type": "string"},
                    "score": {"type": "integer", "description": "0-100"},
                    "comment": {
                        "type": "string",
                        "description": "1-2 sentences, concrete and frame-level — "
                        "what you saw and the specific gap, not generic praise.",
                    },
                },
                "required": ["key", "label", "score", "comment"],
            },
        },
        "strengths": {
            "type": "array",
            "items": {"type": "string"},
            "description": "What the creator did well — keep doing it. 2-4 items.",
        },
        "missing": {
            "type": "array",
            "items": {"type": "string"},
            "description": "What the brief asked for that is absent or weak. Empty if "
            "nothing is missing.",
        },
        "note": {
            "type": "string",
            "description": "The Slack-ready coaching note sent to the creator: warm, "
            "direct, specific, actionable. Lead with the verdict in plain words, then "
            "2-4 concrete fixes ranked by impact, then one genuine encouragement. No "
            "markdown headers — it pastes straight into Slack/DM.",
        },
    },
    "required": ["verdict", "overall_score", "dimensions", "strengths", "missing", "note"],
}


_SYSTEM = (
    "You are a senior UGC creative director at a video agency reviewing a creator's "
    "delivery against a brief. Your job is to coach the part of the video that "
    "transcripts can't see — the visual hook, tone/energy match, pacing, and "
    "adherence to the brief or a reference video. You are given pre-extracted "
    "frame-level signals (hook text/format/strength, tone adjectives/voice/"
    "speaking-style, pacing cut-frequency/shot-length, on-screen OCR text, a "
    "transcript excerpt). Reason ONLY over what the signals show. If the delivery "
    "isn't analysed or a signal is absent, say so rather than inventing it. Be "
    "specific and frame-level; never give generic feedback. Score consistently so a "
    "creator's progress trends honestly across deliveries."
)


def _prompt(review: dict, source: dict, reference: dict | None) -> str:
    import json

    parts = ["# DELIVERY (the video being reviewed)", json.dumps(source, indent=2)]
    if review.get("brief"):
        parts += [
            "\n# BRIEF (what the creator was asked to make)",
            (review.get("brief_title") or "Brief") + "\n" + review["brief"],
        ]
    else:
        parts.append("\n# BRIEF\n(no written brief provided — judge against the reference / general UGC craft)")
    if reference and reference.get("status") == "done":
        parts += ["\n# REFERENCE VIDEO (the target style to match)", json.dumps(reference, indent=2)]
    elif review.get("reference_video_id"):
        parts.append("\n# REFERENCE VIDEO\n(a reference was provided but isn't analysed — note that the reference comparison is unavailable)")
    parts.append(
        "\nReview this delivery. Return the structured verdict, per-dimension scores "
        "with concrete comments, strengths, what's missing vs the brief, and the "
        "Slack-ready coaching note."
    )
    return "\n".join(parts)


def generate_review(review_id: str) -> None:
    """Gather → reason → persist for one review. Sets status 'ready' on success,
    'failed' (with error) on any problem. Safe to call again to regenerate."""
    review = db.get_review(review_id)
    if review is None:
        return
    try:
        source = _video_brief(review["delivery_video_id"])
        if source.get("status") != "done":
            raise RuntimeError(
                f"delivery not analysed ({source.get('status')}): "
                f"{source.get('note') or 'cannot review yet'}"
            )
        reference = (
            _video_brief(review["reference_video_id"])
            if review.get("reference_video_id")
            else None
        )

        with dev_events.track("review", "generate review", detail=review_id):
            client = _client()
            resp = client.messages.create(
                model=REVIEW_MODEL,
                max_tokens=4096,
                system=_SYSTEM,
                tools=[{
                    "name": "submit_review",
                    "description": "Submit the structured UGC delivery review.",
                    "input_schema": _REVIEW_SCHEMA,
                }],
                tool_choice={"type": "tool", "name": "submit_review"},
                messages=[{"role": "user", "content": _prompt(review, source, reference)}],
            )

        result: dict | None = None
        for block in resp.content:
            if block.type == "tool_use" and block.name == "submit_review":
                result = block.input  # type: ignore[assignment]
                break
        if not result:
            raise RuntimeError("model returned no structured review")

        dims = result.get("dimensions") or []
        scores = {
            d["key"]: d["score"]
            for d in dims
            if isinstance(d, dict) and isinstance(d.get("score"), (int, float))
        }
        db.update_review(
            review_id,
            status="ready",
            verdict=result.get("verdict"),
            overall_score=result.get("overall_score"),
            scores=scores,
            dimensions=dims,
            strengths=result.get("strengths") or [],
            missing=result.get("missing") or [],
            note=result.get("note"),
            error=None,
        )
    except Exception as exc:  # noqa: BLE001 — never let a review crash the request
        db.update_review(review_id, status="failed", error=f"{type(exc).__name__}: {exc}"[:500])

    db.pg_notify_change({"type": "review", "action": "updated", "review_id": review_id})


def _wait_for_video(video_id: str, deadline: float) -> str:
    """Block until a video's analysis settles. Returns 'done' | 'failed' | 'timeout'."""
    while time.monotonic() < deadline:
        res = db.get_video_analysis(video_id)
        status = (res or {}).get("status")
        if status == "done":
            return "done"
        if status == "failed":
            return "failed"
        time.sleep(_WATCH_INTERVAL_SEC)
    return "timeout"


def _watch(review_id: str, delivery_video_id: str, reference_video_id: str | None) -> None:
    deadline = time.monotonic() + _WATCH_TIMEOUT_SEC
    delivery = _wait_for_video(delivery_video_id, deadline)
    if delivery != "done":
        reason = "analysis timed out" if delivery == "timeout" else "delivery analysis failed"
        db.update_review(review_id, status="failed", error=reason)
        db.pg_notify_change({"type": "review", "action": "updated", "review_id": review_id})
        return
    # Reference is best-effort: wait for it to settle but review even if it failed
    # (generate_review degrades honestly when the reference isn't analysed).
    if reference_video_id:
        _wait_for_video(reference_video_id, deadline)
    generate_review(review_id)


def spawn_review_watcher(review_id: str, delivery_video_id: str,
                         reference_video_id: str | None = None) -> None:
    """Fire-and-forget: once the delivery (and reference) finish analysing, generate
    the review. Daemon thread — the DB pool is thread-safe."""
    threading.Thread(
        target=_watch,
        args=(review_id, delivery_video_id, reference_video_id),
        daemon=True,
    ).start()


def spawn_generate(review_id: str) -> None:
    """Fire-and-forget regenerate of an already-analysed review (the Re-run action)."""
    threading.Thread(target=generate_review, args=(review_id,), daemon=True).start()
