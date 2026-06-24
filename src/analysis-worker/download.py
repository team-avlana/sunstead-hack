import json
import subprocess
from datetime import datetime
from pathlib import Path


def download_video(source_url: str, workdir: Path) -> dict:
    """Download with yt-dlp and return metadata.

    Returns dict with: local_path, title, duration_sec, published_at,
    resolution, fps, width, height.
    """
    # Fetch metadata first (fast, no download)
    meta_result = subprocess.run(
        ["yt-dlp", "--dump-json", "--no-playlist", source_url],
        capture_output=True,
        text=True,
        check=True,
    )
    info = json.loads(meta_result.stdout)

    ext = info.get("ext", "mp4")
    output_template = str(workdir / f"source.%(ext)s")

    subprocess.run(
        [
            "yt-dlp",
            "--no-playlist",
            "-o", output_template,
            "--format", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
            "--merge-output-format", "mp4",
            source_url,
        ],
        check=True,
    )

    # Resolve actual output path (yt-dlp may change extension after merge)
    candidates = sorted(workdir.glob("source.*"), key=lambda p: p.stat().st_mtime, reverse=True)
    local_path = str(candidates[0]) if candidates else str(workdir / f"source.{ext}")

    published_at = None
    upload_date = info.get("upload_date")
    if upload_date:
        try:
            published_at = datetime.strptime(upload_date, "%Y%m%d")
        except ValueError:
            pass

    return {
        "local_path": local_path,
        "title": info.get("title", ""),
        "duration_sec": float(info.get("duration") or 0.0),
        "published_at": published_at,
        "resolution": f"{info.get('width', 0)}x{info.get('height', 0)}",
        "fps": float(info.get("fps") or 0.0),
        "width": info.get("width"),
        "height": info.get("height"),
    }
