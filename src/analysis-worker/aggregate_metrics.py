"""
Deterministic cross-video aggregation helpers for the style-profile builder.

Works entirely off videos.metrics.deterministic (and a few fields from
videos.metrics.llm for ab_roll/broll_density). Never re-opens frames or video files.
"""

import statistics

import numpy as np
from sklearn.cluster import KMeans


# ─── statistics helpers ──────────────────────────────────────────────────────

def _stat_block(values: list[float]) -> dict:
    """Central tendency + spread for a list of floats. Returns None fields when empty."""
    if not values:
        return {"mean": None, "median": None, "min": None, "max": None, "std": None, "count": 0}
    return {
        "mean": round(statistics.mean(values), 3),
        "median": round(statistics.median(values), 3),
        "min": round(min(values), 3),
        "max": round(max(values), 3),
        "std": round(statistics.stdev(values), 3) if len(values) > 1 else 0.0,
        "count": len(values),
    }


def _safe_floats(videos: list[dict], *path: str) -> list[float]:
    """Collect non-None floats by traversing a key path into videos[i]['metrics']."""
    result = []
    for v in videos:
        node = v.get("metrics", {})
        for key in path:
            if not isinstance(node, dict):
                node = None
                break
            node = node.get(key)
        if node is not None:
            try:
                result.append(float(node))
            except (TypeError, ValueError):
                pass
    return result


def _count_dist(values: list) -> dict:
    """Frequency distribution for a list of categorical values."""
    dist: dict[str, int] = {}
    for v in values:
        if v is not None:
            dist[str(v)] = dist.get(str(v), 0) + 1
    total = sum(dist.values())
    return {
        k: {"count": c, "ratio": round(c / total, 4)}
        for k, c in sorted(dist.items(), key=lambda x: -x[1])
    } if total else {}


# ─── palette clustering ──────────────────────────────────────────────────────

def _cluster_palette(colors: list[tuple], n: int = 8) -> list[dict]:
    """K-means cluster (r,g,b,weight) tuples into n representative palette entries."""
    if not colors:
        return []
    n = max(1, min(n, len(colors)))
    arr = np.array([[r, g, b] for r, g, b, _ in colors], dtype=np.float32)
    weights = np.array([w for _, _, _, w in colors])
    km = KMeans(n_clusters=n, n_init=3, random_state=42)
    labels = km.fit_predict(arr)
    centers = km.cluster_centers_.astype(int)
    cluster_w = np.zeros(n)
    for lbl, w in zip(labels, weights):
        cluster_w[lbl] += w
    total_w = cluster_w.sum()
    return [
        {
            "hex": "#{:02x}{:02x}{:02x}".format(
                int(centers[i][0]), int(centers[i][1]), int(centers[i][2])
            ),
            "weight": round(float(cluster_w[i] / total_w), 4) if total_w > 0 else 0.0,
        }
        for i in np.argsort(-cluster_w)
    ]


# ─── main aggregation ────────────────────────────────────────────────────────

def aggregate_deterministic(videos: list[dict]) -> dict:
    """
    Compute cross-video deterministic aggregates from videos.metrics.deterministic.
    Returns a dict with stat_blocks for each metric plus per-video arrays.
    """
    det_list = [v.get("metrics", {}).get("deterministic", {}) or {} for v in videos]

    def vals(key: str) -> list[float]:
        return [float(d[key]) for d in det_list if d.get(key) is not None]

    # Pacing / editing
    cut_freq_vals = vals("cut_frequency")
    avg_shot_vals = vals("avg_shot_len")
    fast_cut_vals = vals("fast_cut_ratio")
    long_take_vals = vals("long_take_ratio")
    first_cut_vals = vals("time_to_first_cut")

    # Speech
    wpm_vals = vals("words_per_minute")
    speech_vals = vals("speech_ratio")

    # Visual
    brightness_vals = vals("avg_brightness")
    saturation_vals = vals("avg_saturation")
    contrast_vals = vals("avg_contrast")
    warm_cool_vals = vals("warm_cool_balance")

    # Composition (from deterministic layer)
    talking_head_vals = vals("talking_head_ratio")
    text_ratio_vals = vals("onscreen_text_ratio")

    # AB-roll from LLM layer (set alongside deterministic by convention)
    ab_roll_vals = _safe_floats(videos, "llm", "ab_roll_ratio")
    broll_density_raw = [
        v.get("metrics", {}).get("llm", {}).get("broll_density")
        for v in videos
        if v.get("metrics", {}).get("llm", {}).get("broll_density")
    ]

    # Pool all per-video palette colors for cross-video clustering
    all_colors: list[tuple] = []
    for d in det_list:
        for c in d.get("palette", []):
            h = c.get("hex", "")
            w = float(c.get("weight", 0.0))
            try:
                r, g, b = int(h[1:3], 16), int(h[3:5], 16), int(h[5:7], 16)
                all_colors.append((r, g, b, w))
            except (ValueError, IndexError):
                pass

    # Per-video array — lets the LLM and later steps see variability
    per_video = [
        {
            "video_id": v.get("id"),
            "title": v.get("title"),
            "duration_sec": v.get("duration_sec"),
            "cut_frequency": d.get("cut_frequency"),
            "avg_shot_len": d.get("avg_shot_len"),
            "fast_cut_ratio": d.get("fast_cut_ratio"),
            "words_per_minute": d.get("words_per_minute"),
            "speech_ratio": d.get("speech_ratio"),
            "ab_roll_ratio": v.get("metrics", {}).get("llm", {}).get("ab_roll_ratio"),
        }
        for v, d in zip(videos, det_list)
    ]

    return {
        "video_count": len(videos),
        "total_duration_sec": round(sum(v.get("duration_sec") or 0 for v in videos), 1),
        "cut_frequency": _stat_block(cut_freq_vals),
        "avg_shot_len": _stat_block(avg_shot_vals),
        "fast_cut_ratio": _stat_block(fast_cut_vals),
        "long_take_ratio": _stat_block(long_take_vals),
        "time_to_first_cut": _stat_block(first_cut_vals),
        "words_per_minute": _stat_block(wpm_vals),
        "speech_ratio": _stat_block(speech_vals),
        "avg_brightness": _stat_block(brightness_vals),
        "avg_saturation": _stat_block(saturation_vals),
        "avg_contrast": _stat_block(contrast_vals),
        "warm_cool_balance": _stat_block(warm_cool_vals),
        "talking_head_ratio": _stat_block(talking_head_vals),
        "onscreen_text_ratio": _stat_block(text_ratio_vals),
        "ab_roll_ratio": _stat_block(ab_roll_vals),
        "broll_density_distribution": _count_dist(broll_density_raw),
        "palette": _cluster_palette(all_colors, n=8),
        "per_video": per_video,
    }


# ─── soft signal collection ──────────────────────────────────────────────────

_SOFT_DETAIL_LIMIT = 20  # max videos with full LLM field detail


def collect_soft_signals(videos: list[dict]) -> tuple[list[dict], bool]:
    """
    Extract per-video LLM narrative signals for the synthesis prompt.

    Returns (signals, was_truncated). Videos beyond _SOFT_DETAIL_LIMIT are
    included as summary-only entries to stay within token budget.
    """
    truncated = len(videos) > _SOFT_DETAIL_LIMIT
    if truncated:
        print(
            f"[build_profile] {len(videos)} videos exceed soft-signal detail budget "
            f"({_SOFT_DETAIL_LIMIT}); first {_SOFT_DETAIL_LIMIT} shown in full, "
            f"remainder as style-summary only."
        )

    signals = []
    for i, v in enumerate(videos):
        llm = v.get("metrics", {}).get("llm", {}) or {}
        if i < _SOFT_DETAIL_LIMIT:
            signals.append({
                "video_id": v.get("id"),
                "title": v.get("title"),
                "duration_sec": v.get("duration_sec"),
                "hook_format": llm.get("hook_format"),
                "hook_strength": llm.get("hook_strength"),
                "hook_opening_words": llm.get("hook_opening_words"),
                "hook_reasoning": llm.get("hook_reasoning"),
                "tone_voice": llm.get("tone_voice"),
                "tone_adjectives": llm.get("tone_adjectives"),
                "speaking_style": llm.get("speaking_style"),
                "scriptedness": llm.get("scriptedness"),
                "scriptedness_reasoning": llm.get("scriptedness_reasoning"),
                "topic": llm.get("topic"),
                "subtopics": llm.get("subtopics"),
                "audience_pain_point": llm.get("audience_pain_point"),
                "value_proposition": llm.get("value_proposition"),
                "narrative_arc": llm.get("narrative_arc"),
                "retention_tactics": llm.get("retention_tactics"),
                "cta_present": llm.get("cta_present"),
                "cta_type": llm.get("cta_type"),
                "cta_placement": llm.get("cta_placement"),
                "ab_roll_ratio": llm.get("ab_roll_ratio"),
                "broll_density": llm.get("broll_density"),
                "overall_style_summary": llm.get("overall_style_summary"),
            })
        else:
            summary = llm.get("overall_style_summary")
            if summary:
                signals.append({
                    "video_id": v.get("id"),
                    "title": v.get("title"),
                    "truncated": True,
                    "overall_style_summary": summary,
                })

    return signals, truncated
