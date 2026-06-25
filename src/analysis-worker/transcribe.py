import os
import shutil
import subprocess
from pathlib import Path

_FFMPEG = shutil.which("ffmpeg") or "ffmpeg"


def extract_audio(video_path: str, output_path: str) -> None:
    """Extract mono 16 kHz WAV audio."""
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
    """Transcribe using the ElevenLabs Scribe API.

    Requires ELEVENLABS_API_KEY in the environment.
    Returns dict: {text, segments, words}
    Segments: [{start, end, text, words: [{word, start, end}]}]
    Words: flat list of all word timings.
    """
    import requests

    api_key = os.environ.get("ELEVENLABS_API_KEY", "")
    if not api_key:
        raise RuntimeError("ELEVENLABS_API_KEY is not set")

    audio_path = str(workdir / "audio.wav")
    extract_audio(video_path, audio_path)

    with open(audio_path, "rb") as f:
        response = requests.post(
            "https://api.elevenlabs.io/v1/speech-to-text",
            headers={"xi-api-key": api_key},
            files={"audio": ("audio.wav", f, "audio/wav")},
            data={
                "model_id": "scribe_v1",
                "timestamps_granularity": "word",
            },
            timeout=300,
        )
    response.raise_for_status()
    return _normalise_transcript(response.json())


def _normalise_transcript(raw: dict) -> dict:
    """Normalise ElevenLabs Scribe output into {text, segments, words}.

    ElevenLabs returns a flat words array; entries with type=="word" carry
    start/end in seconds. We build a single segment spanning the full audio.
    """
    full_text = raw.get("text", "")
    word_entries = [w for w in raw.get("words", []) if w.get("type") == "word"]
    words = [
        {"word": w["text"], "start": w["start"], "end": w["end"]}
        for w in word_entries
    ]

    start = words[0]["start"] if words else 0.0
    end = words[-1]["end"] if words else 0.0
    segments = [{"start": start, "end": end, "text": full_text, "words": words}]

    return {"text": full_text, "segments": segments, "words": words}


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
