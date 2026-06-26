import json
import os
import subprocess
import time
from datetime import datetime
from pathlib import Path


def _cookie_args() -> list[str]:
    """yt-dlp authentication for sites that wall anonymous downloads (Instagram,
    sometimes TikTok). Configure exactly ONE, via env (inherited from the service's
    .env), else returns [] and downloads run anonymously:

      YTDLP_COOKIES_FILE          path to a Netscape cookies.txt exported from a
                                  browser that is logged into the site.
      YTDLP_COOKIES_FROM_BROWSER  a browser yt-dlp reads cookies from live, e.g.
                                  'firefox', 'chrome', 'safari', 'edge'
                                  (optionally 'chrome:Default').

    The file is the most reliable (no Keychain/profile-lock issues); the browser
    option is the quickest if you're already logged in.
    """
    cookies_file = os.environ.get("YTDLP_COOKIES_FILE", "").strip()
    if cookies_file:
        return ["--cookies", cookies_file]
    browser = os.environ.get("YTDLP_COOKIES_FROM_BROWSER", "").strip()
    if browser:
        return ["--cookies-from-browser", browser]
    return []


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
    cmd = ["yt-dlp", "--dump-json", "--no-playlist", *_cookie_args(), source_url]
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


def _parse_fps(rate: str) -> float:
    """Parse an ffprobe frame rate like '30000/1001' or '25/1' to a float."""
    try:
        if "/" in rate:
            num, den = rate.split("/", 1)
            den_f = float(den)
            return float(num) / den_f if den_f else 0.0
        return float(rate)
    except (ValueError, ZeroDivisionError):
        return 0.0


def probe_local(path: str) -> dict:
    """Probe an already-local file (an uploaded delivery) with ffprobe instead of
    downloading. Returns the same shape as download_video so the pipeline is
    identical from shot detection onward. Sidesteps the IG/TikTok yt-dlp login
    wall (D42): the agency already has the source file."""
    duration = 0.0
    width = height = 0
    fps = 0.0
    cmd = [
        "ffprobe", "-v", "quiet", "-print_format", "json",
        "-show_format", "-show_streams", path,
    ]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True)
        if out.returncode == 0:
            data = json.loads(out.stdout)
            duration = float((data.get("format") or {}).get("duration") or 0.0)
            for s in data.get("streams", []):
                if s.get("codec_type") == "video":
                    width = int(s.get("width") or 0)
                    height = int(s.get("height") or 0)
                    fps = _parse_fps(s.get("avg_frame_rate") or s.get("r_frame_rate") or "0/1")
                    break
    except Exception:
        pass

    return {
        "local_path": path,
        "title": Path(path).stem,
        "duration_sec": duration,
        "published_at": None,
        "resolution": f"{width}x{height}",
        "fps": fps,
        "width": width or None,
        "height": height or None,
    }


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
        *_cookie_args(),
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
