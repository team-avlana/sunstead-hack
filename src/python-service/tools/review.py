"""Compare tool — gather a SOURCE video and a TARGET (a brief frame, or another
video) into one compact result the agent can reason over, then build a review
frame from with create_artifact.

This tool GATHERS and SHAPES data only. It does not judge: the verdict, the
"what's missing" list, and the coaching note are the agent's reasoning, written as
ordinary text/video blocks (see the UGC REVIEW LOOP in the MCP server instructions).
Keeping the brain in the agent is deliberate — the model gets better at editing our
own data structures over time with no extra work here.
"""

from typing import Any, Optional

from fastmcp import FastMCP

import db


def _f(v: Any) -> Optional[float]:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _video_brief(video_id: Optional[str]) -> dict:
    """Compact, comparison-ready view of one video: the analysis fields the review
    rubric needs, plus the per-shot OCR (for the on-screen hook check). A video that
    isn't analysed comes back with status != 'done' so the agent degrades honestly."""
    if not video_id:
        return {"video_id": None, "status": "missing"}
    res = db.get_video_analysis(video_id)
    if res is None:
        return {"video_id": video_id, "status": "missing"}

    status = res.get("status")
    v = res.get("video") or {}
    if status != "done":
        return {
            "video_id": video_id,
            "status": status,
            "title": v.get("title"),
            "note": v.get("analysis_error") or "not analysed yet",
        }

    metrics = v.get("metrics") or {}
    llm = metrics.get("llm") or {}
    det = metrics.get("deterministic") or {}
    transcript = ((metrics.get("transcript") or {}).get("text") or "")

    # On-screen text per shot (OCR) — the visual-hook check matches the brief's
    # required on-screen text against this.
    ocr: list[str] = []
    full = db.get_video_full(video_id) or {}
    for s in full.get("shots", []) or []:
        frame = (((s.get("analysis") or {}).get("deterministic") or {}).get("frame") or {})
        t = str(frame.get("ocr_text") or "").strip()
        if t:
            ocr.append(t)

    return {
        "video_id": video_id,
        "status": "done",
        "title": v.get("title"),
        "duration_sec": _f(v.get("duration_sec")),
        "hook": {
            "text": llm.get("hook_text"),
            "format": llm.get("hook_format"),
            "strength": llm.get("hook_strength"),
            "opening_words": llm.get("hook_opening_words"),
        },
        "tone": {
            "adjectives": llm.get("tone_adjectives"),
            "voice": llm.get("tone_voice"),
            "speaking_style": llm.get("speaking_style"),
            "scriptedness": llm.get("scriptedness"),
        },
        "segments": llm.get("segments"),
        "pacing": {
            "cut_frequency": det.get("cut_frequency"),
            "avg_shot_len": det.get("avg_shot_len"),
            "fast_cut_ratio": det.get("fast_cut_ratio"),
            "shot_count": det.get("shot_count"),
        },
        "on_screen_text": ocr,
        "overall_style_summary": llm.get("overall_style_summary"),
        "transcript_excerpt": transcript[:800],
    }


def _frame_brief(artifact_id: str) -> dict:
    """A brief frame as the agent needs it: its text blocks (hook, notes, …) plus
    the id of any reference video block it contains."""
    art = db.get_artifact(artifact_id)
    if art is None:
        return {"artifact_id": artifact_id, "error": "frame not found"}
    payload = art.get("payload") or {}
    blocks: list[dict] = []
    ref_video_id: Optional[str] = None
    for el in payload.get("elements") or []:
        if not isinstance(el, dict):
            continue
        if el.get("type") == "text":
            blocks.append({
                "title": el.get("title") or "",
                "subtitle": el.get("subtitle") or "",
                "body": el.get("body") or "",
            })
        elif el.get("type") == "video" and not ref_video_id:
            ref_video_id = el.get("video_id")
    return {
        "artifact_id": artifact_id,
        "title": art.get("title") or payload.get("label"),
        "role": payload.get("role"),
        "text_blocks": blocks,
        "reference_video_id": ref_video_id,
    }


def register(mcp: FastMCP) -> None:

    @mcp.tool()
    def compare_components(source_video_id: str, target: dict) -> dict:
        """
        Gather everything needed to review/compare a SOURCE video against a TARGET,
        in one call, so you can reason over the result and then build the review
        frame with create_artifact.

        This GATHERS data only — the verdict, the "what's missing" list and the
        coaching note are YOUR reasoning, written as text/video blocks (see the
        UGC REVIEW LOOP in the server instructions).

        source_video_id: the delivery / video being reviewed (should be analysed).
        target: one of
          {"kind": "frame", "artifact_id": "<brief frame id>"} — review against a
              brief. Returns the brief's text blocks (hook, notes, …) and, if the
              frame holds a reference video, that reference's analysis too.
          {"kind": "video", "video_id": "<other video id>"} — compare two videos.

        Returns {source, target}. Each video is shaped compactly: hook, tone,
        segments, pacing, on_screen_text (OCR, for the hook check), a transcript
        excerpt. A video with status != "done" isn't analysed — say so in the review
        rather than inventing a comparison.

        Next: create ONE frame artifact (payload.role="review") with the verdict +
        score header, the per-dimension blocks (Visual hook, Reference, Tone,
        Pacing, Constraints, Missing, Strengths), the source video block, and a
        "Send to creator" note. Pass project_id explicitly.
        """
        if not source_video_id:
            raise ValueError("source_video_id is required")
        if not isinstance(target, dict):
            raise ValueError("target must be an object with a 'kind'")

        source = _video_brief(source_video_id)
        kind = target.get("kind")

        if kind == "frame":
            aid = target.get("artifact_id")
            if not aid:
                raise ValueError("target.artifact_id is required for kind='frame'")
            frame = _frame_brief(aid)
            ref_id = frame.pop("reference_video_id", None)
            return {
                "source": source,
                "target": {
                    "kind": "frame",
                    "brief": frame,
                    "reference": _video_brief(ref_id) if ref_id else None,
                },
            }

        if kind == "video":
            tvid = target.get("video_id")
            if not tvid:
                raise ValueError("target.video_id is required for kind='video'")
            return {"source": source, "target": {"kind": "video", "video": _video_brief(tvid)}}

        raise ValueError("target.kind must be 'frame' or 'video'")
