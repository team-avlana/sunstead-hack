import json
import shutil
import subprocess
from pathlib import Path

_FFMPEG = shutil.which("ffmpeg") or "ffmpeg"


def extract_audio(video_path: str, output_path: str) -> None:
    """Extract mono 16 kHz WAV audio for CrispASR."""
    subprocess.run(
        [
            _FFMPEG,
            "-y",
            "-i",
            video_path,
            "-ac",
            "1",
            "-ar",
            "16000",
            "-vn",
            output_path,
        ],
        check=True,
        capture_output=True,
    )


def transcribe(video_path: str, workdir: Path) -> dict:
    """Transcribe using the CrispASR CLI (Cohere backend, qwen3 aligner).

    Returns dict: {text, segments, words}
    Segments are [{start, end, text, words: [{word, start, end}]}].
    Words is a flat list of all word timings across segments.

    CrispASR CLI assumptions (verify against https://github.com/CrispStrobe/CrispASR):
      crispasr --backend cohere --aligner qwen3 --output <path.json> <audio.wav>
    If the exact flag names differ, adjust CRISPASR_CMD below or set
    CRISPASR_EXTRA_ARGS in the environment.
    """
    import os

    audio_path = str(workdir / "audio.wav")
    extract_audio(video_path, audio_path)

    extra_args = os.environ.get("CRISPASR_EXTRA_ARGS", "").split()

    crispasr_bin = shutil.which("crispasr")
    if crispasr_bin is None:
        raise RuntimeError("crispasr not found on PATH")

    cmd = [
        crispasr_bin,
        "--backend",
        "parakeet",
        # "-am",
        # "auto",
        # "--force-aligner",
        # "--auto-download",
        # "-ml",
        # "1",
        # "-t",
        # "1",
        # "-ck",
        # "60",
        "-ojf",
        *extra_args,
        audio_path,
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(
            f"CrispASR exited {result.returncode}:\n{result.stderr[:800]}"
        )

    # CrispASR always writes <input-stem>.json next to the input file
    output_path = workdir / "audio.json"
    if not output_path.exists():
        raise RuntimeError(
            f"CrispASR succeeded but audio.json was not found in {workdir}.\n"
            f"stdout: {result.stdout[:400]}\nstderr: {result.stderr[:400]}"
        )
    raw = json.loads(output_path.read_text(encoding="utf-8"))

    # Normalise to a consistent shape regardless of minor CrispASR output variants
    return _normalise_transcript(raw)


def _normalise_transcript(raw: dict) -> dict:
    """Normalise parakeet output into {text, segments, words}.

    Parakeet format:
      raw["transcription"] = [{offsets: {from, to}, text, tokens: [{text, p, t0, t1}]}]
      offsets are in milliseconds; t0/t1 are in centiseconds (×0.01 = seconds).
    A token whose text starts with a space begins a new word.
    """
    entries = raw.get("transcription", [])

    all_words: list[dict] = []
    norm_segments: list[dict] = []

    for entry in entries:
        start_sec = entry["offsets"]["from"] / 1000.0
        end_sec = entry["offsets"]["to"] / 1000.0
        text = entry.get("text", "")
        words = _tokens_to_words(entry.get("tokens", []))
        norm_segments.append({"start": start_sec, "end": end_sec, "text": text, "words": words})
        all_words.extend(words)

    full_text = " ".join(s["text"] for s in norm_segments)
    return {"text": full_text, "segments": norm_segments, "words": all_words}


def _tokens_to_words(tokens: list[dict]) -> list[dict]:
    """Assemble sub-word tokens into word-level entries with timestamps.

    A space-prefixed token text marks the start of a new word.
    t0/t1 are in centiseconds; convert to seconds with ×0.01.
    """
    words: list[dict] = []
    current: dict | None = None

    for tok in tokens:
        text = tok["text"]
        t0 = tok["t0"] * 0.01
        t1 = tok["t1"] * 0.01

        if text.startswith(" "):
            if current is not None:
                words.append(current)
            stripped = text.lstrip(" ")
            current = {"word": stripped, "start": t0, "end": t1} if stripped else None
        else:
            if current is not None:
                current["word"] += text
                current["end"] = t1
            else:
                current = {"word": text, "start": t0, "end": t1}

    if current is not None:
        words.append(current)

    return words


def slice_transcript_for_shot(
    transcript: dict, start_sec: float, end_sec: float
) -> dict:
    """Return transcript subset whose words/segments overlap [start_sec, end_sec)."""
    shot_segments = []
    shot_words = []

    for seg in transcript.get("segments", []):
        if seg["end"] <= start_sec or seg["start"] >= end_sec:
            continue
        seg_words = [
            w
            for w in seg.get("words", [])
            if w["end"] > start_sec and w["start"] < end_sec
        ]
        shot_segments.append({**seg, "words": seg_words})
        shot_words.extend(seg_words)

    text = " ".join(seg["text"].strip() for seg in shot_segments).strip()
    return {
        "text": text,
        "segments": shot_segments,
        "words": shot_words,
        "word_list": [w["word"] for w in shot_words],
    }
