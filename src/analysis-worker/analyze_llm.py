import base64
import json
import os

import config

# ─── JSON schemas for forced tool use ───────────────────────────────────────

_PER_SHOT_SCHEMA = {
    "type": "object",
    "properties": {
        "shot_type": {
            "type": "string",
            "enum": [
                "extreme_wide", "wide", "medium", "close_up", "extreme_close_up",
                "insert", "screen_recording", "other",
            ],
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
        # ── Hook ──────────────────────────────────────────────────────────────
        "hook_text": {"type": "string"},
        "hook_opening_words": {"type": "string"},
        "hook_format": {
            "type": "string",
            "enum": [
                "question", "bold_claim", "story", "teaser_open_loop",
                "statistic", "pattern_interrupt", "demonstration", "other",
            ],
        },
        "hook_strength": {"type": "integer", "minimum": 1, "maximum": 10},
        "hook_reasoning": {"type": "string"},
        # ── B-roll ────────────────────────────────────────────────────────────
        "ab_roll_ratio": {"type": "number", "minimum": 0, "maximum": 1},
        "broll_density": {
            "type": "string",
            "enum": ["heavy", "moderate", "light", "none"],
        },
        # ── Structure ─────────────────────────────────────────────────────────
        "segments": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "label": {"type": "string"},
                    "start_sec": {"type": "number"},
                    "end_sec": {"type": "number"},
                    "description": {"type": "string"},
                },
                "required": ["label", "start_sec", "end_sec"],
            },
        },
        # ── CTA ───────────────────────────────────────────────────────────────
        "cta_present": {"type": "boolean"},
        "cta_type": {
            "type": "string",
            "enum": ["subscribe", "follow", "link", "product", "none"],
        },
        "cta_placement": {
            "type": "string",
            "enum": ["early", "mid", "end", "none"],
        },
        # ── Narrative ─────────────────────────────────────────────────────────
        "narrative_arc": {"type": "string"},
        "retention_tactics": {"type": "array", "items": {"type": "string"}},
        # ── Topic & audience ──────────────────────────────────────────────────
        "topic": {"type": "string"},
        "subtopics": {"type": "array", "items": {"type": "string"}},
        "audience_pain_point": {"type": "string"},
        "value_proposition": {"type": "string"},
        "inferred_audience": {"type": "string"},
        # ── Voice & style ─────────────────────────────────────────────────────
        "tone_voice": {"type": "string"},
        "tone_adjectives": {
            "type": "array",
            "items": {"type": "string"},
            "minItems": 3,
        },
        "scriptedness": {
            "type": "string",
            "enum": ["scripted", "semi_scripted", "improvised"],
        },
        "scriptedness_reasoning": {"type": "string"},
        "speaking_style": {
            "type": "string",
            "enum": [
                "first_person_story", "second_person_instructional",
                "third_person_analytical", "conversational",
                "list_based", "interview", "other",
            ],
        },
        # ── Language ──────────────────────────────────────────────────────────
        "language": {"type": "string"},
        "reading_level": {"type": "string"},
        # ── Moments ───────────────────────────────────────────────────────────
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
        "hook_text", "hook_opening_words", "hook_format", "hook_strength", "hook_reasoning",
        "ab_roll_ratio", "broll_density", "segments", "cta_present",
        "cta_type", "cta_placement", "narrative_arc", "retention_tactics",
        "topic", "subtopics", "audience_pain_point", "value_proposition",
        "inferred_audience", "tone_voice", "tone_adjectives", "scriptedness",
        "scriptedness_reasoning", "speaking_style", "language", "reading_level",
        "overall_style_summary",
    ],
}


# ─── client factory ─────────────────────────────────────────────────────────

def _client():
    azure_url = os.environ.get("AZURE_ANTHROPIC_URL", "")
    azure_key = os.environ.get("AZURE_ANTHROPIC_KEY", "")
    anthropic_key = os.environ.get("ANTHROPIC_API_KEY", "")

    if azure_url and azure_key:
        from anthropic import AnthropicFoundry
        return AnthropicFoundry(base_url=azure_url, api_key=azure_key)
    if anthropic_key:
        import anthropic
        return anthropic.Anthropic(api_key=anthropic_key)
    raise RuntimeError(
        "No Anthropic credentials found. Set ANTHROPIC_API_KEY "
        "or both AZURE_ANTHROPIC_URL and AZURE_ANTHROPIC_KEY."
    )


# ─── per-shot analysis ───────────────────────────────────────────────────────

def analyze_shot(frame_bytes: bytes | None, transcript_slice: dict, idx: int) -> dict:
    """Vision + text analysis for one shot. Returns raw LLM JSON."""
    client = _client()
    transcript_text = transcript_slice.get("text", "").strip()

    content: list = []
    if frame_bytes:
        content.append({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": "image/jpeg",
                "data": base64.standard_b64encode(frame_bytes).decode("utf-8"),
            },
        })

    content.append({"type": "text", "text": _shot_prompt(idx, transcript_text)})

    response = client.messages.create(
        model=config.LLM_PER_SHOT_MODEL,
        max_tokens=8192,
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


def _shot_prompt(idx: int, transcript_text: str) -> str:
    speech_line = (
        f'Spoken words in this shot: "{transcript_text}"'
        if transcript_text
        else "No speech in this shot (silent or B-roll)."
    )
    return (
        f"You are analyzing shot #{idx} from a video for a content creator style profile.\n\n"
        f"{speech_line}\n\n"
        "Classify this shot carefully:\n"
        "• shot_type — camera framing: extreme_wide/wide/medium/close_up/"
        "extreme_close_up/insert/screen_recording/other\n"
        "• roll — a_roll = presenter speaking to camera or on-screen interview; "
        "b_roll = supporting footage, cutaway, demonstration, product shot\n"
        "• roll_confidence — 0 (unsure) to 1 (certain)\n"
        "• is_talking_head — true only if a human face is the dominant subject "
        "occupying most of the frame\n"
        "• subject — concise noun phrase (e.g. 'presenter at whiteboard', "
        "'city skyline at dusk', 'close-up of hands typing')\n"
        "• composition — how the primary subject is positioned\n"
        "• composition_notes — any notable framing, depth, or lighting technique\n"
        "• onscreen_text_purpose — why text is overlaid (none if none visible)\n\n"
        "Call analyze_shot with your findings."
    )


# ─── video-level synthesis ───────────────────────────────────────────────────

def analyze_video_level(transcript: dict, shots: list[dict], duration_sec: float) -> dict:
    """Holistic narrative analysis from full transcript + aggregated shot data."""
    client = _client()

    full_text = transcript.get("text", "").strip()
    if not full_text:
        full_text = " ".join(
            seg.get("text", "") for seg in transcript.get("segments", [])
        ).strip()

    # Compact shot summary to avoid token explosion on long videos
    shot_summary = [
        {
            "idx": s["idx"],
            "start_sec": round(s["start_sec"], 1),
            "end_sec": round(s["end_sec"], 1),
            "duration_sec": round(s["end_sec"] - s["start_sec"], 1),
            "shot_type": s.get("analysis", {}).get("llm", {}).get("shot_type"),
            "roll": s.get("analysis", {}).get("llm", {}).get("roll"),
            "is_talking_head": s.get("analysis", {}).get("llm", {}).get("is_talking_head"),
            "subject": s.get("analysis", {}).get("llm", {}).get("subject"),
            "mood": s.get("analysis", {}).get("llm", {}).get("mood"),
        }
        for s in shots[:80]  # cap at 80 shots for context budget
    ]

    response = client.messages.create(
        model=config.LLM_VIDEO_LEVEL_MODEL,
        max_tokens=8192,
        tools=[{
            "name": "analyze_video",
            "description": "Return comprehensive video-level narrative analysis.",
            "input_schema": _VIDEO_LEVEL_SCHEMA,
        }],
        tool_choice={"type": "tool", "name": "analyze_video"},
        messages=[{"role": "user", "content": _video_level_prompt(full_text, shot_summary, duration_sec)}],
    )

    for block in response.content:
        if block.type == "tool_use" and block.name == "analyze_video":
            return block.input  # type: ignore[return-value]
    return {}


def _video_level_prompt(full_text: str, shot_summary: list[dict], duration_sec: float) -> str:
    n_shots = len(shot_summary)

    return f"""You are building a creator style profile from a single video. \
Your goal is to extract the narrative "fingerprint" — the patterns that would let \
a human recognize this creator across multiple videos. \
Prioritize depth over brevity; be specific, not generic.

Total duration: {duration_sec:.1f}s | {n_shots} shots

FULL TRANSCRIPT:
{full_text or "(no transcript available)"}

SHOT BREAKDOWN:
{json.dumps(shot_summary, indent=2)}

---

Analyze in this order of importance:

**1. HOOK** (first ~5–15 seconds)
- hook_opening_words: Copy the verbatim first 8–12 words spoken. If no speech, \
describe the opening visual action.
- hook_text: The full hook — quote or closely paraphrase the opening hook. \
Include what is shown AND said. Be specific enough that someone who hasn't seen \
the video could picture it.
- hook_format: What psychological mechanism does the hook use?
  • question — direct question posed to the viewer
  • bold_claim — strong, possibly controversial assertion
  • story — a narrative setup ("Last Tuesday I made a $10k mistake...")
  • teaser_open_loop — explicit promise of a payoff ("By the end of this video you'll know...")
  • statistic — a surprising data point used as an opener
  • pattern_interrupt — something unexpected that breaks the viewer's mental autopilot
  • demonstration — showing a compelling result before explaining how
- hook_strength: 1–10. Be rigorous: 10 = would stop a scroll cold, immediately \
creates curiosity or desire; 7–8 = solid but familiar; 4–6 = competent but generic; \
1–3 = weak, easily ignored.
- hook_reasoning: WHY does this hook work or fail? Name the specific psychological \
lever (curiosity gap, fear of missing out, social proof, identity signal, etc.) \
and explain how the opening lines trigger it. Quote specific words that carry the weight.

**2. TONE & VOICE** (the creator's signature)
- tone_voice: A single rich phrase a casting director would use (e.g. \
"authoritative-but-approachable expert", "enthusiastic friend sharing a secret", \
"deadpan comedian with genuine expertise").
- tone_adjectives: 4–8 specific adjectives. Reject generics like "energetic" — \
prefer compound descriptors: "rapid-fire-but-precise", "self-deprecating", \
"data-obsessed", "warm-but-opinionated".
- speaking_style: How is content delivered structurally?
  • first_person_story — "I did X and discovered..."
  • second_person_instructional — "You should do X because..."
  • third_person_analytical — "Studies show / The data says..."
  • conversational — informal back-and-forth feel
  • list_based — "Here are 5 reasons..."
  • interview — Q&A or guest format
- scriptedness: scripted / semi_scripted / improvised
- scriptedness_reasoning: What specific cues support this? (filler words, \
sentence variation, natural tangents, vocal hesitations, consistent rhetorical patterns)

**3. TOPIC & POSITIONING**
- topic: Core topic in 4–8 words as you'd tell a stranger.
- subtopics: The specific sub-points or angles covered (2–6 items).
- audience_pain_point: Frame it as the viewer's internal monologue at the moment \
they would click this video (e.g. "I keep failing at X and don't know why", \
"I want to achieve Y but it feels out of reach").
- value_proposition: The creator's implicit promise — what transformation or \
insight will the viewer have gained by the end?

**4. NARRATIVE STRUCTURE**
- narrative_arc: Describe the logical or emotional journey in one sentence \
(e.g. "Problem → failed conventional advice → creator's contrarian insight → \
proof → simple framework").
- segments: Break the video into 4–8 labeled sections with timestamps and a \
one-line description of what each section accomplishes narratively.
- retention_tactics: List specific devices used to keep viewers watching. \
Be concrete — not just "open loops" but "At 0:22 the creator says 'I'll show you \
the exact number at the end' and never revisits it until 8:45". \
Common tactics: curiosity gaps, teasers, callbacks, cliffhangers, pattern breaks, \
social proof moments, re-hooks after b-roll cuts.

**5. REMAINING FIELDS**
- ab_roll_ratio: Fraction of shots classified as b_roll (0–1).
- broll_density: heavy / moderate / light / none.
- cta_present / cta_type / cta_placement.
- inferred_audience: Age range, interest level, platform context.
- language / reading_level.
- notable_moments: 2–5 timestamp-anchored moments that are clip-worthy, \
emotionally resonant, or structurally pivotal.
- overall_style_summary: 2–4 sentences capturing this creator's style fingerprint \
— write it as a brief you'd give to a ghostwriter who needs to mimic this creator's \
voice. Include their signature hook pattern, tonal quality, and narrative structure.

Call analyze_video with your complete analysis."""
