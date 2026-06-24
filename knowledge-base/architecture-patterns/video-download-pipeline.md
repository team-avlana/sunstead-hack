# Video Download Pipeline (yt-dlp) for Rainy

_Last updated: 2026-06-24_

Implementation reference for the **download stage** of Rainy: pulling source videos + metadata from **YouTube, TikTok, and Instagram** into local storage for the downstream scene-analysis pipeline (see `scene-analysis-pipeline.md`). yt-dlp runs inside the Python sidecar described in `python-sidecar-in-mac-app.md`.

> **ToS / legal flag (read first).** Downloading from YouTube, TikTok, and Instagram is, in the general case, **against each platform's Terms of Service**. Downloading copyrighted content you do not own, or content you lack a license/permission to reuse, can be infringement. Rainy is a creator tool — design it for **the user's own content, licensed content, or fair-use analysis**, surface the ToS reality to the user, and do not bundle credentials. Nothing here is legal advice. Per-platform caveats are repeated in each section.
>
> **Fragility flag.** TikTok and Instagram extractors break **frequently** (often weekly) as those platforms change their web internals. Treat them as best-effort, pin a recent yt-dlp, and update aggressively (see §8). Numbers/behaviour below reflect mid-2026 and will drift.

---

## 1. Why yt-dlp

- Single library covering **1800+ sites** (YouTube, TikTok, Instagram all first-class extractors), actively maintained with near-daily nightly releases.
- Clean **Python API** (`yt_dlp.YoutubeDL`) — no subprocess-of-a-subprocess; embed it directly in the sidecar.
- Emits rich **metadata JSON**, subtitles/auto-captions, thumbnails, and handles separate video+audio stream muxing via **ffmpeg**.

**Requirements:** Python 3.10+ and **ffmpeg on PATH** (or pass `ffmpeg_location`). ffmpeg is required to merge `bestvideo+bestaudio`, extract audio, embed subs/thumbnails, and remux. Rainy already bundles a relocatable Python; bundle a signed `ffmpeg`/`ffprobe` alongside it and point yt-dlp at it.

Install in the sidecar venv:

```bash
uv pip install --python ./PythonRuntime/venv "yt-dlp[default]"
# or pin a nightly for fresh extractor fixes:
# uv pip install "yt-dlp[default] @ https://github.com/yt-dlp/yt-dlp/releases/download/nightly/yt_dlp-<ver>-py3-none-any.whl"
```

---

## 2. Python API: metadata only (no download)

Use this for the "paste a URL → show preview + duration + thumbnail" UX before committing to a download.

```python
import yt_dlp

def probe(url: str) -> dict:
    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        # don't expand whole playlists/profiles when you only want one item:
        "noplaylist": True,
        # 'extract_flat': 'in_playlist',  # for fast playlist listing without per-item resolve
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False)
        # Make it JSON-serializable (strips internal-only keys / lambdas):
        return ydl.sanitize_info(info)

info = probe("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
print(info["id"], info["title"], info["duration"], info["uploader"])
```

Key fields in the info dict: `id`, `title`, `description`, `uploader` / `uploader_id` / `channel`, `duration` (seconds), `upload_date` (YYYYMMDD), `view_count`, `like_count`, `thumbnails` (list), `formats` (list of available streams), `subtitles`, `automatic_captions`, `webpage_url`, `extractor`, `width`/`height`/`fps`. Always run results through `ydl.sanitize_info()` before persisting or sending over IPC.

---

## 3. Downloading best video+audio

```python
import yt_dlp

def download(url: str, out_dir: str) -> dict:
    ydl_opts = {
        # Prefer mp4/m4a container; fall back to best merged:
        "format": "bestvideo*+bestaudio/best",
        "merge_output_format": "mp4",          # remux merged A/V into mp4
        "outtmpl": {
            "default": f"{out_dir}/%(extractor)s/%(id)s/%(id)s.%(ext)s",
        },
        "restrictfilenames": True,             # ASCII-safe filenames
        "windowsfilenames": False,
        "noplaylist": True,
        "writeinfojson": True,                 # sidecar metadata JSON (see §5)
        "writethumbnail": True,                # save thumbnail next to video
        "writesubtitles": True,                # uploader-provided subs
        "writeautomaticsub": True,             # YouTube auto-captions
        "subtitleslangs": ["en.*", "-live_chat"],
        "subtitlesformat": "vtt/srt/best",
        "quiet": True,
        "no_warnings": True,
        # bundled ffmpeg:
        # "ffmpeg_location": "/path/inside/app/Contents/Resources/bin",
        "postprocessors": [
            # Embed metadata + chapters into the container:
            {"key": "FFmpegMetadata", "add_metadata": True, "add_chapters": True},
            # Convert auto-captions to a consistent format if present:
            {"key": "FFmpegSubtitlesConvertor", "format": "srt"},
        ],
        # Progress hook → forward % to Swift over the sidecar channel:
        "progress_hooks": [_on_progress],
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=True)
        return ydl.sanitize_info(info)

def _on_progress(d):
    if d["status"] == "downloading":
        # d has: downloaded_bytes, total_bytes(_estimate), speed, eta, _percent_str
        pass
    elif d["status"] == "finished":
        pass  # post-processing (merge/remux) starts after this
```

### Knowing where the file landed
After download, the **final** path (post-merge) is reliably available via `requested_downloads`:

```python
final_path = info["requested_downloads"][0]["filepath"]
```

Prefer this over reconstructing from `outtmpl` — the extension changes after merge/remux.

---

## 4. Format selection cheat-sheet

yt-dlp format strings are powerful; common picks for an analysis pipeline:

| Goal | `format` string |
|---|---|
| Best quality merged | `bestvideo*+bestaudio/best` |
| Cap at 1080p (saves disk/decode for VLM) | `bestvideo[height<=1080]+bestaudio/best[height<=1080]` |
| Cap at 720p, prefer mp4 | `bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720]` |
| Audio only (for transcript path) | `bestaudio/best` + `FFmpegExtractAudio` postprocessor |
| Smallest file that's still watchable | `worst[height>=360]/worst` |

`*` allows muxed (non-`bestvideo`-only) formats to satisfy the selector — useful for TikTok/Instagram which often serve single muxed files rather than split A/V. List available formats programmatically via `info["formats"]` (each has `format_id`, `ext`, `vcodec`, `acodec`, `height`, `fps`, `filesize`/`filesize_approx`, `tbr`).

For analysis you usually do **not** need 4K — capping at 720–1080p drastically cuts download time, disk, and downstream decode/VLM cost. **Recommend 720p cap as Rainy's default**, user-overridable.

---

## 5. The metadata JSON yt-dlp emits

With `writeinfojson: True`, yt-dlp writes `<outtmpl>.info.json` next to the media. It is the **`sanitize_info(info)`** dict serialized — i.e. everything from §2 plus download-time fields (`requested_downloads`, `filepath`, chosen `format_id`, `resolution`, actual `filesize`). Persist this verbatim as the canonical source-of-truth for each video; Rainy's own DB rows can be a projection of it.

`.info.json` can also be **re-loaded** to redownload/repair without re-hitting the network for metadata:

```python
with yt_dlp.YoutubeDL({"load_info_filename": "video.info.json"}) as ydl:
    ydl.download_with_info_file("video.info.json")
```

---

## 6. Rate limiting, retries, politeness

Throttle to avoid IP/account flags (especially on TikTok/Instagram):

```python
ydl_opts.update({
    "ratelimit": 5_000_000,          # 5 MB/s cap on download
    "throttledratelimit": 100_000,   # restart if speed drops below 100 KB/s (anti-throttle)
    "sleep_interval": 2,             # min seconds between requests
    "max_sleep_interval": 6,         # randomized up to this
    "sleep_interval_requests": 1,    # sleep between each request within an extraction
    "retries": 10,
    "fragment_retries": 10,
    "file_access_retries": 5,
    "concurrent_fragment_downloads": 4,  # speeds up HLS/DASH without more requests/s
})
```

Run downloads **serially per platform** in Rainy's queue; do not fan out many parallel extractions to the same site.

---

## 7. Cookies & auth (TikTok / Instagram / age-gated YouTube)

Public videos on all three often work **without** auth. You need cookies for: private/age-restricted/region-locked content, Instagram in general (increasingly login-walled), and to dodge "confirm you're not a bot" challenges.

Two mechanisms:

```python
# (a) Export cookies from the user's browser at runtime:
ydl_opts["cookiesfrombrowser"] = ("safari",)        # or ("chrome",), ("firefox",), ("brave",)
# tuple can be (browser, profile, keyring, container)

# (b) Point at a Netscape-format cookies.txt the user supplies:
ydl_opts["cookiefile"] = "/path/to/cookies.txt"
```

**Gotchas (2026):**
- **Chrome/Chromium cookie extraction is unreliable** — newer Chrome encrypts the cookie DB (App-Bound encryption / DPAPI-style) such that `cookiesfrombrowser=("chrome",)` frequently fails or returns empties. **Firefox and Safari extraction are far more reliable.** Recommend guiding users to Firefox/Safari, or a manual `cookies.txt` export.
- yt-dlp must be able to **read the browser cookie store** — Chrome must be **fully quit** on some platforms; sandboxed Mac App Store builds may be blocked from reading another app's cookie DB entirely (another reason Developer-ID distribution is the realistic baseline, per the sidecar doc).
- **Never bundle or ship cookies.** Always use the end-user's own session, with explicit consent, stored in their keychain/app-support dir, never logged.
- A stale/expired cookie set is worse than none — surface auth failures clearly and let the user re-auth.

---

## 8. Per-platform notes

### YouTube — most robust
- Split video+audio streams → **ffmpeg merge required** for best quality.
- Rich **auto-captions** (`writeautomaticsub`) and uploader subs — useful as a free transcript signal alongside VLM frame analysis.
- Bot checks ("Sign in to confirm you're not a bot") are increasingly common from datacenter/VPN IPs; mitigate with `cookiesfrombrowser`, residential IP, and current yt-dlp. The `player_client` extractor-arg can help when the default web client is challenged:
  ```python
  ydl_opts["extractor_args"] = {"youtube": {"player_client": ["default", "ios", "web_safari"]}}
  ```
- Age-restricted videos need cookies; note a long-standing bug where cookies sometimes don't satisfy age gates — keep yt-dlp updated.
- **ToS:** YouTube ToS prohibit downloading except via features YouTube provides (e.g. Premium offline). Scope Rainy to user-owned/licensed/fair-use.

### TikTok — works but fragile
- Public videos generally download **without cookies** as single muxed mp4 (use `best`/`bestvideo*+bestaudio/best`).
- Watermark vs. no-watermark formats vary by extractor state; check `info["formats"]`.
- Extractor breaks periodically as TikTok rotates its web API; cookies (`cookiesfrombrowser`) help with rate-limiting and region locks. Heavy automated pulls risk IP blocks — throttle hard (§6).
- **ToS:** TikTok ToS prohibit scraping/downloading outside the in-app save feature.

### Instagram — most fragile, increasingly login-walled
- Reels/posts increasingly require **cookies/login**; anonymous access is often blocked or rate-limited fast.
- Private accounts/stories need the user's authenticated session.
- The Instagram extractor is among the **most frequently broken** — pin a fresh yt-dlp and expect intermittent failures. Aggressive requests get accounts/IPs flagged quickly; throttle and serialize.
- **ToS:** Meta/Instagram ToS prohibit automated downloading/scraping. Highest enforcement risk of the three.

---

## 9. Fallbacks if yt-dlp fails (per platform)

Treat these as escalation only, behind the same ToS caveats:

- **All:** first, **update yt-dlp to nightly** — most failures are extractor drift already fixed upstream. Then try alternate `player_client`/`extractor_args`, fresh cookies, a different IP, and capping format (`best[height<=720]`) to dodge problematic high-res manifests.
- **YouTube:** `cookiesfrombrowser`, ios/web_safari player clients, PO-token providers for bot-checked playback (advanced).
- **TikTok / Instagram:** **`gallery-dl`** (mikf/gallery-dl) is the common second tool for these platforms — different extraction internals, sometimes works when yt-dlp doesn't (and vice-versa); it has its own cookie support. For Instagram specifically, an authenticated session is usually the deciding factor regardless of tool.
- If structured extraction fails entirely, the only remaining "download" is screen/stream capture, which is out of scope and generally higher ToS risk — avoid.

---

## 10. Output organization (recommendation for Rainy)

Land everything under a per-video directory keyed by **extractor + id** so re-downloads are idempotent and the analysis pipeline has one folder to scan:

```
~/Library/Application Support/Rainy/library/
  <extractor>/                      # e.g. youtube, tiktok, instagram
    <video_id>/
      <video_id>.mp4                # final merged media (use requested_downloads[].filepath)
      <video_id>.info.json          # canonical metadata (§5)
      <video_id>.en.vtt             # captions / subs
      <video_id>.webp               # thumbnail
      scenes/                       # populated by scene-analysis-pipeline.md
        scene-0001.mp4
        scene-0001-key.jpg
      analysis.json                 # VLM results (downstream)
```

Use `restrictfilenames: True` for ASCII-safe names, and always resolve the real media path from `info["requested_downloads"][0]["filepath"]`. Store the `info.json` as the source of truth and project a normalized row (id, platform, title, duration, uploader, resolution, local_path, downloaded_at) into Rainy's shared store.

---

## Sources

- yt-dlp Python API overview: https://yt-dlp-yt-dlp.mintlify.app/api/overview
- yt-dlp repository (README: format selection, options, postprocessors): https://github.com/yt-dlp/yt-dlp
- yt-dlp `YoutubeDL.py` (option reference, info dict, `sanitize_info`): https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/YoutubeDL.py
- yt-dlp on PyPI: https://pypi.org/project/yt-dlp/
- yt-dlp YouTube authentication wiki: https://deepwiki.com/yt-dlp/yt-dlp-wiki/3.2-youtube-authentication
- yt-dlp cookies-from-browser bot-check issue #12045: https://github.com/yt-dlp/yt-dlp/issues/12045
- "6 Ways to Get YouTube Cookies for yt-dlp in 2026" (Chrome vs Firefox extraction reliability): https://dev.to/osovsky/6-ways-to-get-youtube-cookies-for-yt-dlp-in-2026-only-1-works-2cnb
- yt-dlp Instagram cookie issue #10462: https://github.com/yt-dlp/yt-dlp/issues/10462
- yt-dlp age-restricted cookies issue #13445: https://github.com/yt-dlp/yt-dlp/issues/13445
- gallery-dl (alternative for TikTok/Instagram): https://github.com/mikf/gallery-dl
- yt-dlp 2026 guide (commands/errors): https://www.devkantkumar.com/blog/yt-dlp-ultimate-guide-2026/
