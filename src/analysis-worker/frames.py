import shutil
import subprocess
from pathlib import Path

_FFMPEG = shutil.which("ffmpeg") or "ffmpeg"


def extract_frame(video_path: str, timestamp_sec: float, output_path: str) -> None:
    """Extract a single JPEG frame at timestamp_sec from video_path."""
    subprocess.run(
        [
            _FFMPEG, "-y",
            "-ss", f"{timestamp_sec:.3f}",
            "-i", video_path,
            "-vframes", "1",
            "-q:v", "2",
            output_path,
        ],
        check=True,
        capture_output=True,
    )


def extract_frames_for_shots(video_path: str, shots: list[dict], frames_dir: Path) -> list[dict]:
    """Extract the middle frame for every shot. Adds frame_path to each shot dict."""
    for shot in shots:
        mid_ts = (shot["start_sec"] + shot["end_sec"]) / 2.0
        out = str(frames_dir / f"shot_{shot['idx']:04d}.jpg")
        try:
            extract_frame(video_path, mid_ts, out)
            shot["frame_path"] = out
        except subprocess.CalledProcessError as exc:
            print(f"  frame extraction failed for shot {shot['idx']}: {exc.stderr[-200:]!r}")
            shot["frame_path"] = None
    return shots
