import json
import subprocess
import time
from datetime import datetime
from pathlib import Path


def _yt_dlp_reason(stderr: str, limit: int = 400) -> str:
    """Extract the meaningful failure reason from yt-dlp's stderr.

    yt-dlp prints warnings (e.g. Instagram's "No csrf token set" notice) and then
    a final `ERROR: ...` line. Prefer the last ERROR line; fall back to the last
    non-empty line. This is what keeps the canvas card actionable (e.g. "rate-limit
    reached or login required") instead of a bare "returned non-zero exit status 1".
    """
    lines = [ln.strip() for ln in stderr.splitlines() if ln.strip()]
    if not lines:
        return ""
    errors = [ln for ln in lines if ln.startswith("ERROR")]
    return (errors[-1] if errors else lines[-1])[:limit]


def _dump_json(source_url: str, retries: int = 3) -> dict:
    """Fetch video metadata via yt-dlp, with retry/backoff and a useful error.

    Instagram/TikTok rate-limit by IP and intermittently throw up a login wall, so
    a transient non-zero exit is common; retry a few times before giving up. On
    final failure, raise with yt-dlp's own stderr attached so the card shows *why*.
    """
    cmd = ["yt-dlp", "--dump-json", "--no-playlist", source_url]
    stderr = ""
    for attempt in range(retries):
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode == 0:
            return json.loads(result.stdout)
        stderr = result.stderr or ""
        if attempt < retries - 1:
            time.sleep(2 * (attempt + 1))  # 2s, then 4s
    reason = _yt_dlp_reason(stderr) or "yt-dlp returned no error output"
    raise RuntimeError(f"Could not read this video — {reason}")


def download_video(source_url: str, workdir: Path) -> dict:
    """Download with yt-dlp and return metadata.

    Returns dict with: local_path, title, duration_sec, published_at,
    resolution, fps, width, height.
    """
    # Fetch metadata first (fast, no download)
    info = _dump_json(source_url)

    ext = info.get("ext", "mp4")
    output_template = str(workdir / f"source.%(ext)s")

    # Leave stdout inherited so yt-dlp's "[download] NN%" progress still streams to
    # the worker log / activity panel; capture stderr so a download failure surfaces
    # its reason on the card instead of a bare exit code. Retry with backoff because
    # Instagram/TikTok rate-limit mid-session — a request can succeed then the next
    # gets blocked (yt-dlp resumes partial .part files, so a retry is safe).
    cmd = [
        "yt-dlp",
        "--no-playlist",
        "-o", output_template,
        "--format", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
        "--merge-output-format", "mp4",
        source_url,
    ]
    stderr = ""
    for attempt in range(3):
        dl = subprocess.run(cmd, stderr=subprocess.PIPE, text=True)
        if dl.returncode == 0:
            break
        stderr = dl.stderr or ""
        if attempt < 2:
            time.sleep(2 * (attempt + 1))  # 2s, then 4s
    else:
        reason = _yt_dlp_reason(stderr) or "yt-dlp returned no error output"
        raise RuntimeError(f"Could not download this video — {reason}")

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
