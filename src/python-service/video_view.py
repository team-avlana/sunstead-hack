"""Derive the canvas "Video Block" view-model from a videos row + its shots.

The canvas is dumb: it renders whatever this returns. We map the analysis
pyramid (videos.metrics = {llm, transcript, deterministic} + shots[].analysis)
into the progressive-disclosure fields the Video Block shows:

    *   Title, thumbnail, tags        (shown from "not analysed" on)
    **  transcript, description       (shown once transcript exists)
    *** storyboard[scenes]            (shown only when fully analysed)

Status lifecycle (mirrors schema.sql):
    analysis_error set        -> "error"
    analyzed_at set           -> "analysed"
    row exists, neither       -> "analysing"
    (no row / placeholder)    -> "not_analysed" | "empty"  (decided by the artifact)
"""

from __future__ import annotations

from typing import Any

_HOOK_FORMAT_LABEL = {
    "question": "Question hook",
    "bold_claim": "Bold-claim hook",
    "story": "Story hook",
    "teaser_open_loop": "Open-loop hook",
    "statistic": "Stat hook",
    "pattern_interrupt": "Pattern interrupt",
    "demonstration": "Demo hook",
}
_CTA_LABEL = {
    "subscribe": "CTA: subscribe",
    "follow": "CTA: follow",
    "link": "CTA: link",
    "product": "CTA: product",
}


def status_of(video: dict) -> str:
    if video.get("analysis_error"):
        return "error"
    if video.get("analyzed_at"):
        return "analysed"
    return "analysing"


def _palette(metrics: dict | None, limit: int = 6) -> list[str]:
    if not isinstance(metrics, dict):
        return []
    det = metrics.get("deterministic") or {}
    pal = det.get("palette") or []
    out: list[str] = []
    for p in pal:
        hexv = p.get("hex") if isinstance(p, dict) else None
        if isinstance(hexv, str) and hexv.startswith("#"):
            out.append(hexv)
        if len(out) >= limit:
            break
    return out


_JUNK_PREFIXES = (
    "unknown", "undetermined", "indeterminate", "n/a", "none",
    "unclear", "not applicable", "not determined", "unclassified",
)


def _short(text: str, limit: int = 28) -> str:
    """Trim to <= limit chars on a word boundary (no mid-word cut)."""
    text = " ".join(text.split())
    if len(text) <= limit:
        return text
    cut = text[:limit].rsplit(" ", 1)[0]
    return (cut or text[:limit]).rstrip(" ,;-")


def _is_junk(tag: str) -> bool:
    t = tag.lower().strip(" ,;-—")
    return not t or any(t.startswith(p) for p in _JUNK_PREFIXES)


def _tags(llm: dict) -> list[str]:
    """Punchy chips for the block header — clean nouns, not full sentences."""
    tags: list[str] = []
    topic = llm.get("topic")
    if isinstance(topic, str) and topic:
        t = _short(topic.split(",")[0].split("—")[0], 24)
        if not _is_junk(t):
            tags.append(t)
    hf = _HOOK_FORMAT_LABEL.get(llm.get("hook_format", ""))
    if hf:
        tags.append(hf)
    if llm.get("cta_present"):
        ct = _CTA_LABEL.get(llm.get("cta_type", ""))
        if ct:
            tags.append(ct)
    scr = llm.get("scriptedness")
    if isinstance(scr, str) and scr and not _is_junk(scr):
        tags.append(scr.replace("_", "-"))
    tone = llm.get("tone_voice")
    if isinstance(tone, str) and tone:
        t = _short(tone.split(",")[0], 20)
        if not _is_junk(t):
            tags.append(t)
    lang = llm.get("language")
    if isinstance(lang, str) and lang and lang.lower() != "english" and not _is_junk(lang):
        tags.append(lang)
    # de-dupe (case-insensitive), keep order
    seen, uniq = set(), []
    for t in tags:
        k = t.lower()
        if t and k not in seen:
            seen.add(k)
            uniq.append(t)
    return uniq[:6]


def _shot_for_segment(shots: list[dict], start: float, end: float) -> dict | None:
    """Pick the shot whose midpoint falls inside [start, end] (else the closest)."""
    best, best_d = None, 1e9
    for s in shots:
        mid = (float(s.get("start_sec", 0)) + float(s.get("end_sec", 0))) / 2
        if start <= mid <= end:
            return s
        d = min(abs(mid - start), abs(mid - end))
        if d < best_d:
            best, best_d = s, d
    return best


def _frame_url(frame_id: str | None) -> str | None:
    if not frame_id:
        return None
    return f"/frames/{frame_id}"


def _scene_tags(shot: dict | None) -> list[str]:
    if not shot:
        return []
    llm = (shot.get("analysis") or {}).get("llm") or {}
    out = []
    for key in ("shot_type", "roll", "composition"):
        v = llm.get(key)
        if isinstance(v, str) and v and v != "other" and not _is_junk(v):
            out.append(v.replace("_", " "))
    return out


def _storyboard(llm: dict, shots: list[dict]) -> list[dict]:
    segments = llm.get("segments") or []
    scenes = []
    for i, seg in enumerate(segments):
        if not isinstance(seg, dict):
            continue
        start = float(seg.get("start_sec", 0) or 0)
        end = float(seg.get("end_sec", start) or start)
        shot = _shot_for_segment(shots, start, end)
        subject = ((shot or {}).get("analysis") or {}).get("llm", {}).get("subject")
        scenes.append(
            {
                "idx": i,
                "label": seg.get("label") or f"Scene {i + 1}",
                "start_sec": start,
                "end_sec": end,
                "thumbnail": _frame_url((shot or {}).get("frame_id")),
                "tags": _scene_tags(shot),
                "description": subject or "",
            }
        )
    return scenes


def _pct(x: Any) -> str | None:
    return f"{round(float(x) * 100)}%" if isinstance(x, (int, float)) else None


def _secs(x: Any) -> str | None:
    return f"{round(float(x), 1)}s" if isinstance(x, (int, float)) else None


def _num(x: Any, digits: int = 0) -> str | None:
    if not isinstance(x, (int, float)):
        return None
    return str(round(float(x), digits)) if digits else str(round(float(x)))


def metrics_summary(video: dict) -> list[dict]:
    """Headline video-level metrics for the deep-dive view, grouped.

    Pulls from videos.metrics (deterministic aggregates + llm synthesis) — the
    rich layer the Video Block doesn't surface — and skips any missing keys.
    Each item: {group, label, value}. Returns [] for an unanalysed video.
    """
    metrics = video.get("metrics") if isinstance(video.get("metrics"), dict) else {}
    det = metrics.get("deterministic") if isinstance(metrics, dict) else None
    llm = metrics.get("llm") if isinstance(metrics, dict) else None
    det = det if isinstance(det, dict) else {}
    llm = llm if isinstance(llm, dict) else {}

    out: list[dict] = []

    def add(group: str, label: str, value: Any) -> None:
        if value is None or value == "":
            return
        out.append({"group": group, "label": label, "value": str(value)})

    # Pacing
    add("Pacing", "Cuts / min", _num(det.get("cut_frequency"), 1))
    add("Pacing", "Avg shot", _secs(det.get("avg_shot_len")))
    add("Pacing", "Fast cuts", _pct(det.get("fast_cut_ratio")))
    add("Pacing", "Long takes", _pct(det.get("long_take_ratio")))
    add("Pacing", "To first cut", _secs(det.get("time_to_first_cut")))

    # Speech
    add("Speech", "Words / min", _num(det.get("words_per_minute")))
    add("Speech", "Total words", _num(det.get("total_words")))
    add("Speech", "Speech", _pct(det.get("speech_ratio")))
    add("Speech", "Silence", _pct(det.get("silence_ratio")))
    add("Speech", "Reading level", llm.get("reading_level"))

    # Visual
    add("Visual", "Talking head", _pct(det.get("talking_head_ratio")))
    add("Visual", "On-screen text", _pct(det.get("onscreen_text_ratio")))
    add("Visual", "Warm/cool", _num(det.get("warm_cool_balance"), 2))
    add("Visual", "Brightness", _num(det.get("avg_brightness")))
    add("Visual", "Saturation", _num(det.get("avg_saturation")))

    # Narrative (llm synthesis)
    hs = llm.get("hook_strength")
    add("Narrative", "Hook strength", f"{hs}/10" if isinstance(hs, (int, float)) else None)
    add("Narrative", "B-roll density", llm.get("broll_density"))
    add("Narrative", "A/B-roll ratio", _num(llm.get("ab_roll_ratio"), 2))
    add("Narrative", "Scriptedness", (llm.get("scriptedness") or "").replace("_", " ") or None)
    add("Narrative", "CTA", llm.get("cta_type") if llm.get("cta_present") else None)

    return out


def derive_video(video: dict, shots: list[dict] | None = None) -> dict:
    """Build the Video Block view-model. `video` is a videos row (with metrics);
    `shots` is the list of shot rows (idx, start_sec, end_sec, frame_path, analysis)."""
    shots = shots or []
    metrics = video.get("metrics") if isinstance(video.get("metrics"), dict) else {}
    llm = (metrics.get("llm") or {}) if isinstance(metrics, dict) else {}
    if not isinstance(llm, dict) or llm.get("error"):
        llm = {} if not isinstance(llm, dict) else {k: v for k, v in llm.items() if k != "error"}
    transcript = (metrics.get("transcript") or {}) if isinstance(metrics, dict) else {}
    status = status_of(video)
    analysed = status == "analysed"

    rep_shot = shots[0] if shots else None
    duration = video.get("duration_sec")

    view = {
        "video_id": str(video.get("id") or video.get("video_id") or ""),
        "status": status,
        "source_url": video.get("source_url"),
        "title": video.get("title"),
        "duration_sec": float(duration) if duration is not None else None,
        "thumbnail": _frame_url((rep_shot or {}).get("frame_id")),
        "palette": _palette(metrics),
        "shot_count": len(shots),
        "analysis_error": video.get("analysis_error"),
        # ** transcript / description
        "transcript": (transcript.get("text") or "").strip() or None,
        "description": (llm.get("overall_style_summary") or llm.get("narrative_arc") or "").strip()
        or None,
        # * tags
        "tags": _tags(llm) if analysed else [],
        # hook highlight
        "hook": (
            {
                "text": llm.get("hook_text"),
                "format": llm.get("hook_format"),
                "strength": llm.get("hook_strength"),
            }
            if llm.get("hook_text")
            else None
        ),
        # *** storyboard
        "storyboard": _storyboard(llm, shots) if analysed else [],
    }
    return view
