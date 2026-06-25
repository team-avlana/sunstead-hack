import base64
import json
import os
from pathlib import Path

from anthropic import AnthropicFoundry

import config

# ─── JSON schemas for forced tool use ───────────────────────────────────────

_PER_SHOT_SCHEMA = {
    "type": "object",
    "properties": {
        "shot_type": {
            "type": "string",
            "enum": ["extreme_wide", "wide", "medium", "close_up", "extreme_close_up",
                     "insert", "screen_recording", "other"],
        },
        "roll": {"type": "string", "enum": ["a_roll", "b_roll"]},
        "roll_confidence": {"type": "number", "minimum": 0, "maximum": 1},
        "is_talking_head": {"type": "boolean"},
        "subject": {"type": "string"},
        "composition": {
            "type": "string",
            "enum": ["centered", "rule_of_thirds", "symmetrical", "other"],
        },
        "composition_notes": {"type": "string"},
        "onscreen_text_purpose": {
            "type": "string",
            "enum": ["none", "caption_subtitle", "title", "lower_third", "meme", "data"],
        },
    },
    "required": [
        "shot_type", "roll", "roll_confidence", "is_talking_head", "subject",
        "composition", "onscreen_text_purpose",
    ],
}

_VIDEO_LEVEL_SCHEMA = {
    "type": "object",
    "properties": {
        "hook_text": {"type": "string"},
        "hook_format": {
            "type": "string",
            "enum": ["question", "bold_claim", "story", "teaser_open_loop",
                     "statistic", "pattern_interrupt", "demonstration", "other"],
        },
        "hook_strength": {"type": "integer", "minimum": 1, "maximum": 10},
        "hook_reasoning": {"type": "string"},
        "ab_roll_ratio": {"type": "number", "minimum": 0, "maximum": 1},
        "broll_density": {"type": "string"},
        "segments": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "label": {"type": "string"},
                    "start_sec": {"type": "number"},
                    "end_sec": {"type": "number"},
                },
                "required": ["label", "start_sec", "end_sec"],
            },
        },
        "cta_present": {"type": "boolean"},
        "cta_type": {
            "type": "string",
            "enum": ["subscribe", "follow", "link", "product", "none"],
        },
        "cta_placement": {
            "type": "string",
            "enum": ["early", "mid", "end", "none"],
        },
        "narrative_arc": {"type": "string"},
        "retention_tactics": {"type": "array", "items": {"type": "string"}},
        "topic": {"type": "string"},
        "inferred_audience": {"type": "string"},
        "tone_voice": {"type": "string"},
        "scriptedness": {
            "type": "string",
            "enum": ["scripted", "semi_scripted", "improvised"],
        },
        "scriptedness_reasoning": {"type": "string"},
        "language": {"type": "string"},
        "notable_moments": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "timestamp_sec": {"type": "number"},
                    "description": {"type": "string"},
                },
                "required": ["timestamp_sec", "description"],
            },
        },
        "overall_style_summary": {"type": "string"},
    },
    "required": [
        "hook_text", "hook_format", "hook_strength", "hook_reasoning",
        "ab_roll_ratio", "broll_density", "segments", "cta_present",
        "cta_type", "cta_placement", "narrative_arc", "retention_tactics",
        "topic", "inferred_audience", "tone_voice", "scriptedness",
        "language", "overall_style_summary",
    ],
}


# ─── client factory ─────────────────────────────────────────────────────────

def _client() -> AnthropicFoundry:
    url = os.environ.get("AZURE_ANTHROPIC_URL", "")
    key = os.environ.get("AZURE_ANTHROPIC_KEY", "")
    if not url or not key:
        raise RuntimeError(
            "AZURE_ANTHROPIC_URL and AZURE_ANTHROPIC_KEY must be set for LLM analysis"
        )
    return AnthropicFoundry(base_url=url, api_key=key)


def _encode_image(frame_path: str) -> str:
    return base64.standard_b64encode(Path(frame_path).read_bytes()).decode("utf-8")


# ─── per-shot analysis ───────────────────────────────────────────────────────

def analyze_shot(frame_path: str | None, transcript_slice: dict, idx: int) -> dict:
    """Vision + text analysis for one shot. Returns raw LLM JSON."""
    client = _client()
    transcript_text = transcript_slice.get("text", "").strip()

    content: list = []
    if frame_path and Path(frame_path).exists():
        content.append({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": "image/jpeg",
                "data": _encode_image(frame_path),
            },
        })

    content.append({
        "type": "text",
        "text": (
            f"Analyze video shot #{idx}.\n"
            f"Transcript for this shot: {transcript_text!r}\n\n"
            "Call analyze_shot with your analysis."
        ),
    })

    response = client.messages.create(
        model=config.LLM_PER_SHOT_MODEL,
        max_tokens=1024,
        tools=[{
            "name": "analyze_shot",
            "description": "Return structured analysis of this video shot.",
            "input_schema": _PER_SHOT_SCHEMA,
        }],
        tool_choice={"type": "tool", "name": "analyze_shot"},
        messages=[{"role": "user", "content": content}],
    )

    for block in response.content:
        if block.type == "tool_use" and block.name == "analyze_shot":
            return block.input  # type: ignore[return-value]
    return {}


# ─── video-level synthesis ───────────────────────────────────────────────────

def analyze_video_level(transcript: dict, shots: list[dict], duration_sec: float) -> dict:
    """Holistic video analysis from full transcript + aggregated shot data."""
    client = _client()

    full_text = transcript.get("text", "").strip()
    if not full_text:
        full_text = " ".join(
            seg.get("text", "") for seg in transcript.get("segments", [])
        ).strip()

    # Compact shot summary — avoid token explosion on long videos
    shot_summary = [
        {
            "idx": s["idx"],
            "start_sec": round(s["start_sec"], 1),
            "end_sec": round(s["end_sec"], 1),
            "duration_sec": round(s["end_sec"] - s["start_sec"], 1),
            "shot_type": s.get("analysis", {}).get("llm", {}).get("shot_type"),
            "roll": s.get("analysis", {}).get("llm", {}).get("roll"),
            "is_talking_head": s.get("analysis", {}).get("llm", {}).get("is_talking_head"),
        }
        for s in shots[:80]  # cap at 80 shots for context budget
    ]

    response = client.messages.create(
        model=config.LLM_VIDEO_LEVEL_MODEL,
        max_tokens=2048,
        tools=[{
            "name": "analyze_video",
            "description": "Return comprehensive video-level analysis.",
            "input_schema": _VIDEO_LEVEL_SCHEMA,
        }],
        tool_choice={"type": "tool", "name": "analyze_video"},
        messages=[{
            "role": "user",
            "content": (
                f"Analyze this video. Total duration: {duration_sec:.1f}s, "
                f"{len(shots)} shots.\n\n"
                f"Full transcript:\n{full_text}\n\n"
                f"Shot breakdown:\n{json.dumps(shot_summary, indent=2)}\n\n"
                "Call analyze_video with your comprehensive analysis."
            ),
        }],
    )

    for block in response.content:
        if block.type == "tool_use" and block.name == "analyze_video":
            return block.input  # type: ignore[return-value]
    return {}
