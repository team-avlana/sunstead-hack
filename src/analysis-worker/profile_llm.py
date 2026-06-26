"""
LLM synthesis call for the style-profile aggregation step.

Takes deterministic aggregates + per-video soft signals and returns a
structured style profile ready for insertion into style_profiles.profile.style.
"""

import json
import os
from decimal import Decimal

import config


def _dumps(obj) -> str:
    """json.dumps that coerces Decimal (from psycopg numeric columns) to float."""
    return json.dumps(obj, indent=2, default=lambda o: float(o) if isinstance(o, Decimal) else str(o))

# ─── structured output schema ────────────────────────────────────────────────

_PROFILE_SCHEMA = {
    "type": "object",
    "properties": {
        "style_summary": {"type": "string"},
        "hook_patterns": {
            "type": "object",
            "properties": {
                "common_formats": {"type": "array", "items": {"type": "string"}},
                "typical_strength": {"type": "number"},
                "format_distribution": {
                    "type": "object",
                    "additionalProperties": {"type": "number"},
                },
                "representative_examples": {"type": "array", "items": {"type": "string"}},
                "notes": {"type": "string"},
            },
            "required": ["common_formats", "typical_strength", "notes"],
        },
        "content_structure": {
            "type": "object",
            "properties": {
                "typical_skeleton": {"type": "string"},
                "consistency": {
                    "type": "string",
                    "enum": ["high", "moderate", "low", "variable"],
                },
                "notes": {"type": "string"},
            },
            "required": ["typical_skeleton", "consistency", "notes"],
        },
        "pacing_style": {"type": "string"},
        "visual_style": {"type": "string"},
        "editing_style": {"type": "string"},
        "voice_tone": {
            "type": "object",
            "properties": {
                "description": {"type": "string"},
                "adjectives": {"type": "array", "items": {"type": "string"}},
                "scriptedness_tendency": {
                    "type": "string",
                    "enum": ["scripted", "semi_scripted", "improvised", "mixed"],
                },
                "speaking_style": {"type": "string"},
                "notes": {"type": "string"},
            },
            "required": ["description", "adjectives", "scriptedness_tendency", "speaking_style"],
        },
        "cta_patterns": {
            "type": "object",
            "properties": {
                "present_ratio": {"type": "number"},
                "common_types": {"type": "array", "items": {"type": "string"}},
                "typical_placement": {"type": "string"},
                "notes": {"type": "string"},
            },
            "required": ["present_ratio", "common_types", "typical_placement"],
        },
        "retention_tactics": {"type": "array", "items": {"type": "string"}},
        "topics_niche": {
            "type": "object",
            "properties": {
                "primary": {"type": "string"},
                "recurring_subtopics": {"type": "array", "items": {"type": "string"}},
                "framing": {"type": "string"},
            },
            "required": ["primary", "recurring_subtopics", "framing"],
        },
        "inferred_audience": {"type": "string"},
        "signature_elements": {"type": "array", "items": {"type": "string"}},
        "consistency_notes": {"type": "string"},
        "opportunities": {"type": "array", "items": {"type": "string"}},
    },
    "required": [
        "style_summary", "hook_patterns", "content_structure",
        "pacing_style", "visual_style", "editing_style", "voice_tone",
        "cta_patterns", "retention_tactics", "topics_niche",
        "inferred_audience", "signature_elements", "consistency_notes",
    ],
}


# ─── client ──────────────────────────────────────────────────────────────────

def _client():
    azure_url = os.environ.get("AZURE_ANTHROPIC_URL", "")
    azure_key = os.environ.get("AZURE_ANTHROPIC_KEY", "")
    anthropic_key = os.environ.get("ANTHROPIC_API_KEY", "")

    if azure_url and azure_key:
        from anthropic import AnthropicFoundry
        # AnthropicFoundry also auto-reads ANTHROPIC_FOUNDRY_RESOURCE / _BASE_URL from
        # the environment. The server's agent bridge sets ANTHROPIC_FOUNDRY_RESOURCE,
        # which this worker inherits; combined with the explicit base_url below the SDK
        # raises "base_url and resource are mutually exclusive". We pass base_url
        # ourselves, so drop the inherited foundry vars first.
        os.environ.pop("ANTHROPIC_FOUNDRY_RESOURCE", None)
        os.environ.pop("ANTHROPIC_FOUNDRY_BASE_URL", None)
        return AnthropicFoundry(base_url=azure_url, api_key=azure_key)
    if anthropic_key:
        import anthropic
        return anthropic.Anthropic(api_key=anthropic_key)
    raise RuntimeError(
        "No Anthropic credentials found. Set ANTHROPIC_API_KEY "
        "or both AZURE_ANTHROPIC_URL and AZURE_ANTHROPIC_KEY."
    )


# ─── synthesis call ───────────────────────────────────────────────────────────

def synthesize_profile(
    creator: dict,
    aggregates: dict,
    signals: list[dict],
    truncated: bool,
) -> dict:
    """
    One LLM call that synthesizes deterministic aggregates + per-video soft
    signals into a structured style profile.

    Returns the raw tool-call dict (profile.style).
    """
    client = _client()
    prompt = _build_prompt(creator, aggregates, signals, truncated)

    response = client.messages.create(
        model=config.LLM_SYNTHESIS_MODEL,
        max_tokens=8192,
        tools=[{
            "name": "synthesize_profile",
            "description": "Return the structured creator style profile.",
            "input_schema": _PROFILE_SCHEMA,
        }],
        tool_choice={"type": "tool", "name": "synthesize_profile"},
        messages=[{"role": "user", "content": prompt}],
    )

    for block in response.content:
        if block.type == "tool_use" and block.name == "synthesize_profile":
            return block.input  # type: ignore[return-value]
    return {}


# ─── prompt ──────────────────────────────────────────────────────────────────

def _build_prompt(
    creator: dict,
    aggregates: dict,
    signals: list[dict],
    truncated: bool,
) -> str:
    n = aggregates.get("video_count", 0)
    truncation_note = (
        f"\n⚠ Context limit: {n} total videos analyzed; "
        f"only the first {sum(1 for s in signals if not s.get('truncated'))} are shown "
        f"with full LLM detail. The remainder appear as style-summary-only entries."
    ) if truncated else ""

    return f"""You are building a creator style profile from {n} analyzed video{'s' if n != 1 else ''}.

Creator: {creator.get('name', 'Unknown')} \
(platform: {creator.get('platform') or 'unknown'}, \
kind: {creator.get('kind', 'unknown')}){truncation_note}

Your goal: produce a structured style profile that serves as a context document \
for ideation and scripting in this creator's voice. It must be both descriptive \
("here is what they do") and prescriptive ("here is how to emulate them"). \
Be specific — reference actual examples from the data, quote hook openings verbatim, \
name recurring patterns by name. Reject generic statements that could apply to any creator.

───────────────────────────────────────────────
DETERMINISTIC AGGREGATES (cross-video averages and distributions)
───────────────────────────────────────────────
{_dumps(aggregates)}

───────────────────────────────────────────────
PER-VIDEO SOFT SIGNALS (hook, tone, narrative, etc.)
───────────────────────────────────────────────
{_dumps(signals)}

───────────────────────────────────────────────
SYNTHESIS INSTRUCTIONS
───────────────────────────────────────────────

Analyze in this order of importance:

**1. HOOK PATTERNS** (most important for the narrative fingerprint)
• common_formats: Which hook formats appear most? List in frequency order.
• typical_strength: Average across videos (use the hook_strength values).
• format_distribution: Fraction breakdown per format (e.g. {{"bold_claim": 0.5, "question": 0.3}}).
• representative_examples: Quote 2–4 hook_opening_words verbatim from the data \
  that best illustrate this creator's opening style.
• notes: What is the characteristic "opening move"? What psychological lever do \
  they consistently pull (curiosity gap, identity signal, fear, desire, social proof)? \
  Name any verbal tics, structural habits, or phrasing patterns in their first 10 words.

**2. CONTENT STRUCTURE**
• typical_skeleton: The most common video framework as a short arrow-chain \
  (e.g. "bold_claim hook → 3 examples with b-roll → creator insight → soft CTA").
• consistency: How uniformly do videos follow this skeleton?
• notes: Where do they deviate and what triggers the deviation?

**3. VOICE & TONE** (signature for cross-video recognition)
• description: A single rich phrase a casting director would use \
  (e.g. "authoritative-but-approachable educator with a dry wit").
• adjectives: 5–8 specific compound descriptors. Reject "energetic" — \
  prefer "rapid-fire-but-precise", "self-deprecating", "data-obsessed", \
  "warm-but-opinionated". Draw these from the tone_adjectives across videos.
• scriptedness_tendency: What the aggregate data suggests. Note if mixed.
• speaking_style: The dominant structural delivery pattern.
• notes: Anything that makes their spoken voice immediately recognizable — \
  sentence length, vocabulary level, use of the word "you", favourite phrases, \
  rhetorical patterns.

**4. TOPIC & POSITIONING**
• primary: The niche in 4–8 words.
• recurring_subtopics: The specific angles they return to across multiple videos.
• framing: How they position themselves — expert-to-student, peer-to-peer, \
  entertainer, practical guide, etc.
• inferred_audience: Be specific: age range, interest/expertise level, \
  what they're trying to achieve when they click.

**5. PACING, VISUAL, EDITING**
• pacing_style: Grounded in the cut_frequency and avg_shot_len stats — \
  describe in terms a director or editor would use \
  (e.g. "fast-cut: avg 2.3s shots at 26 cuts/min, accelerates in body, \
  long intro take of ~8s before first cut").
• visual_style: Palette character, lighting quality, shot-type tendencies, \
  composition habits.
• editing_style: Cut rhythm, b-roll density and purpose, on-screen text usage.

**6. RETENTION, CTA, SIGNATURE**
• retention_tactics: The specific devices they use — name them concretely \
  (e.g. "open loop planted at ~0:20, resolved at ~7:30" not just "open loops").
• cta_patterns: present_ratio (fraction of videos with a CTA), common_types, \
  typical_placement, and notes on how integrated vs. bolted-on they feel.
• signature_elements: 3–5 things that would let a regular viewer instantly \
  identify this creator with the sound off.
• consistency_notes: What's highly consistent vs. what varies. \
  If video_count ≤ 3, note low confidence explicitly.

**7. STYLE SUMMARY** (stored verbatim in the database summary column)
• 2–5 sentences. Write it as a brief you'd hand to a ghostwriter. \
  Capture their hook fingerprint, tonal quality, typical structure, and the \
  one distinctive thing that sets them apart. Concrete and specific — no filler phrases.

**8. OPPORTUNITIES** (optional)
• 2–4 content angles or format experiments this creator hasn't fully explored, \
  based on gaps visible in the data.

Call synthesize_profile with your complete analysis.
"""
