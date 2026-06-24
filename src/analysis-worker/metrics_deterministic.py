import statistics
from pathlib import Path
from typing import Optional

import cv2
import numpy as np
from sklearn.cluster import KMeans

# --- optional heavy deps: graceful degradation ---

_mediapipe_detector = None
_HAS_MEDIAPIPE = False
try:
    import mediapipe as mp
    _mediapipe_detector = mp.solutions.face_detection.FaceDetection(
        min_detection_confidence=0.5, model_selection=0
    )
    _HAS_MEDIAPIPE = True
except Exception:
    pass

_ocr_reader = None
_HAS_EASYOCR = False
try:
    import easyocr
    _ocr_reader = easyocr.Reader(["en"], gpu=False, verbose=False)
    _HAS_EASYOCR = True
except Exception:
    pass

_haar_cascade: Optional[cv2.CascadeClassifier] = None


def _get_haar() -> cv2.CascadeClassifier:
    global _haar_cascade
    if _haar_cascade is None:
        _haar_cascade = cv2.CascadeClassifier(
            cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
        )
    return _haar_cascade


# ─────────────────────────────────────────────
#  Per-shot frame metrics
# ─────────────────────────────────────────────

def compute_frame_metrics(frame_path: Optional[str]) -> dict:
    if not frame_path or not Path(frame_path).exists():
        return {"error": "frame_not_found"}

    img_bgr = cv2.imread(frame_path)
    if img_bgr is None:
        return {"error": "unreadable"}

    h, w = img_bgr.shape[:2]
    img_rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
    img_lab = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2LAB)
    img_hsv = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2HSV)
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)

    # Brightness & contrast from L channel
    luma = img_lab[:, :, 0].astype(np.float32)
    brightness = float(np.mean(luma))
    contrast = float(np.std(luma))

    # Saturation
    saturation = float(np.mean(img_hsv[:, :, 1]))

    # Colorfulness (Hasler & Süsstrunk 2003)
    r = img_rgb[:, :, 0].astype(np.float32)
    g = img_rgb[:, :, 1].astype(np.float32)
    b = img_rgb[:, :, 2].astype(np.float32)
    rg = r - g
    yb = 0.5 * (r + g) - b
    colorfulness = float(
        np.sqrt(np.std(rg) ** 2 + np.std(yb) ** 2)
        + 0.3 * np.sqrt(np.mean(rg) ** 2 + np.mean(yb) ** 2)
    )

    # Sharpness (Laplacian variance)
    sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())

    # Dominant colors via k-means
    pixels = img_rgb.reshape(-1, 3).astype(np.float32)
    if len(pixels) > 12000:
        idx = np.random.default_rng(42).choice(len(pixels), 12000, replace=False)
        pixels = pixels[idx]
    km = KMeans(n_clusters=5, n_init=3, random_state=42)
    km.fit(pixels)
    centers = km.cluster_centers_.astype(int)
    counts = np.bincount(km.labels_)
    total = len(km.labels_)
    dominant_colors = [
        {
            "hex": "#{:02x}{:02x}{:02x}".format(int(centers[i][0]), int(centers[i][1]), int(centers[i][2])),
            "weight": round(float(counts[i] / total), 4),
        }
        for i in np.argsort(-counts)
    ]

    # Colour temperature (warm/cool: R vs B channel averages)
    avg_r = float(np.mean(r))
    avg_b = float(np.mean(b))
    color_temp = "warm" if avg_r > avg_b else "cool"

    # Face detection
    face_count = 0
    largest_face_area_ratio = 0.0
    if _HAS_MEDIAPIPE and _mediapipe_detector is not None:
        try:
            res = _mediapipe_detector.process(img_rgb)
            if res.detections:
                face_count = len(res.detections)
                areas = [
                    d.location_data.relative_bounding_box.width
                    * d.location_data.relative_bounding_box.height
                    for d in res.detections
                ]
                largest_face_area_ratio = float(max(areas))
        except Exception:
            pass
    else:
        try:
            faces = _get_haar().detectMultiScale(
                gray, scaleFactor=1.1, minNeighbors=5, minSize=(30, 30)
            )
            if len(faces) > 0:
                face_count = int(len(faces))
                frame_area = h * w
                largest_face_area_ratio = float(
                    max(fw * fh for _, _, fw, fh in faces) / frame_area
                )
        except Exception:
            pass

    # OCR / on-screen text
    has_onscreen_text = False
    text_area_ratio = 0.0
    ocr_text = ""
    if _HAS_EASYOCR and _ocr_reader is not None:
        try:
            ocr_results = _ocr_reader.readtext(frame_path)
            if ocr_results:
                has_onscreen_text = True
                ocr_text = " ".join(r[1] for r in ocr_results)
                total_text_area = sum(
                    abs(
                        (r[0][2][0] - r[0][0][0]) * (r[0][2][1] - r[0][0][1])
                    )
                    for r in ocr_results
                )
                text_area_ratio = float(total_text_area / (w * h))
        except Exception:
            pass

    return {
        "brightness": round(brightness, 2),
        "contrast": round(contrast, 2),
        "saturation": round(saturation, 2),
        "colorfulness": round(colorfulness, 2),
        "dominant_colors": dominant_colors,
        "face_count": face_count,
        "largest_face_area_ratio": round(largest_face_area_ratio, 4),
        "has_onscreen_text": has_onscreen_text,
        "text_area_ratio": round(text_area_ratio, 4),
        "ocr_text": ocr_text,
    }


def compute_shot_speech_metrics(transcript_slice: dict, duration_sec: float) -> dict:
    word_list = transcript_slice.get("word_list", [])
    word_count = len(word_list)
    is_silent = word_count == 0
    wpm = 0.0
    if not is_silent and duration_sec > 0:
        wpm = round(float(word_count / (duration_sec / 60.0)), 1)
    return {
        "word_count": word_count,
        "words_per_minute": wpm,
        "is_silent": is_silent,
    }


# ─────────────────────────────────────────────
#  Video-level aggregates
# ─────────────────────────────────────────────

def compute_video_deterministic_metrics(
    shots: list[dict], transcript: dict, duration_sec: float
) -> dict:
    shot_count = len(shots)
    durations = [s["end_sec"] - s["start_sec"] for s in shots]

    cut_frequency = 0.0
    if duration_sec > 0 and shot_count > 1:
        cut_frequency = round((shot_count - 1) / (duration_sec / 60.0), 3)

    avg_shot_len = round(statistics.mean(durations), 3) if durations else 0.0
    median_shot_len = round(statistics.median(durations), 3) if durations else 0.0
    min_shot_len = round(min(durations), 3) if durations else 0.0
    max_shot_len = round(max(durations), 3) if durations else 0.0
    std_shot_len = round(statistics.stdev(durations), 3) if len(durations) > 1 else 0.0
    fast_cut_ratio = round(sum(1 for d in durations if d < 2.0) / shot_count, 4) if shot_count else 0.0
    long_take_ratio = round(sum(1 for d in durations if d > 5.0) / shot_count, 4) if shot_count else 0.0
    time_to_first_cut = round(shots[0]["end_sec"], 3) if shots else 0.0
    pacing_curve = [round(d, 3) for d in durations]
    rolling_cut_rate = _rolling_cut_rate(shots, duration_sec)

    # Speech / audio from transcript word timings
    total_words = len(transcript.get("words", []))
    wpm_overall, speech_ratio, silence_ratio, longest_pause = _speech_stats(
        transcript.get("words", []), duration_sec
    )

    # Visual aggregates over per-shot frame metrics
    frame_stats = [
        s.get("analysis", {}).get("deterministic", {}).get("frame", {})
        for s in shots
    ]
    frame_stats = [m for m in frame_stats if m and "error" not in m]

    def _safe_mean(key: str) -> float:
        vals = [m[key] for m in frame_stats if key in m]
        return round(statistics.mean(vals), 3) if vals else 0.0

    avg_brightness = _safe_mean("brightness")
    avg_saturation = _safe_mean("saturation")
    avg_contrast = _safe_mean("contrast")



    talking_head_shots = sum(
        1 for s in shots
        if s.get("analysis", {}).get("deterministic", {}).get("frame", {}).get("face_count", 0) > 0
    )
    talking_head_ratio = round(talking_head_shots / shot_count, 4) if shot_count else 0.0

    text_shots = sum(
        1 for s in shots
        if s.get("analysis", {}).get("deterministic", {}).get("frame", {}).get("has_onscreen_text", False)
    )
    onscreen_text_ratio = round(text_shots / shot_count, 4) if shot_count else 0.0

    palette = _aggregate_palette([
        c
        for m in frame_stats
        for c in m.get("dominant_colors", [])
    ])

    return {
        "shot_count": shot_count,
        "duration_sec": round(duration_sec, 3),
        "cut_frequency": cut_frequency,
        "avg_shot_len": avg_shot_len,
        "median_shot_len": median_shot_len,
        "min_shot_len": min_shot_len,
        "max_shot_len": max_shot_len,
        "std_shot_len": std_shot_len,
        "fast_cut_ratio": fast_cut_ratio,
        "long_take_ratio": long_take_ratio,
        "pacing_curve": pacing_curve,
        "rolling_cut_rate": rolling_cut_rate,
        "time_to_first_cut": time_to_first_cut,
        "total_words": total_words,
        "words_per_minute": wpm_overall,
        "speech_ratio": round(speech_ratio, 4),
        "silence_ratio": round(silence_ratio, 4),
        "longest_pause_sec": round(longest_pause, 3),
        "palette": palette,
        "avg_brightness": avg_brightness,
        "avg_saturation": avg_saturation,
        "avg_contrast": avg_contrast,
        "talking_head_ratio": talking_head_ratio,
        "onscreen_text_ratio": onscreen_text_ratio,
    }


def _speech_stats(words: list[dict], duration_sec: float) -> tuple[float, float, float, float]:
    if not words or duration_sec <= 0:
        return 0.0, 0.0, 1.0, 0.0

    intervals = sorted(
        [(w["start"], w["end"]) for w in words if w.get("end", 0) > w.get("start", 0)]
    )
    if not intervals:
        return 0.0, 0.0, 1.0, 0.0

    merged = [list(intervals[0])]
    for s, e in intervals[1:]:
        if s <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])

    speech_time = sum(e - s for s, e in merged)
    speech_ratio = min(1.0, speech_time / duration_sec)
    silence_ratio = 1.0 - speech_ratio

    pauses = [merged[i + 1][0] - merged[i][1] for i in range(len(merged) - 1)]
    longest_pause = max(pauses) if pauses else 0.0

    speaking_min = (speech_time / 60.0)
    wpm = round(len(words) / speaking_min, 1) if speaking_min > 0 else 0.0

    return wpm, speech_ratio, silence_ratio, longest_pause


def _rolling_cut_rate(shots: list[dict], duration_sec: float, window_sec: float = 10.0) -> list[dict]:
    if duration_sec <= 0 or not shots:
        return []
    cut_times = [s["start_sec"] for s in shots[1:]]
    windows = []
    t = 0.0
    while t < duration_sec:
        t_end = min(t + window_sec, duration_sec)
        n_cuts = sum(1 for c in cut_times if t <= c < t_end)
        actual = t_end - t
        rate = round(n_cuts / (actual / 60.0), 2) if actual > 0 else 0.0
        windows.append({"t_start": round(t, 1), "t_end": round(t_end, 1), "cuts_per_minute": rate})
        t += window_sec
    return windows


def _aggregate_palette(colors: list[dict], n_colors: int = 8) -> list[dict]:
    if not colors:
        return []
    rgb_weights = []
    for c in colors:
        h = c.get("hex", "#000000")
        try:
            rgb_weights.append((int(h[1:3], 16), int(h[3:5], 16), int(h[5:7], 16), c.get("weight", 0.0)))
        except (ValueError, IndexError):
            pass
    if not rgb_weights:
        return []
    arr = np.array([[r, g, b] for r, g, b, _ in rgb_weights], dtype=np.float32)
    ws = np.array([w for _, _, _, w in rgb_weights])
    n = min(n_colors, len(arr))
    km = KMeans(n_clusters=n, n_init=3, random_state=42)
    labels = km.fit_predict(arr)
    centers = km.cluster_centers_.astype(int)
    cluster_w = np.zeros(n)
    for lbl, w in zip(labels, ws):
        cluster_w[lbl] += w
    total_w = cluster_w.sum()
    return [
        {
            "hex": "#{:02x}{:02x}{:02x}".format(int(centers[i][0]), int(centers[i][1]), int(centers[i][2])),
            "weight": round(float(cluster_w[i] / total_w), 4) if total_w > 0 else 0.0,
        }
        for i in np.argsort(-cluster_w)
    ]
