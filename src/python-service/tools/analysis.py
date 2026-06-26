"""Analysis tools: trigger video/channel analysis and query progress."""

import base64
import json
import os
import subprocess
import sys
from typing import Optional

from fastmcp import FastMCP

import db
import worker
from config import MAX_CHANNEL_VIDEOS, settings


def register(mcp: FastMCP) -> None:

    @mcp.tool()
    def analyze_video(
        source_url: str,
        creator_id: str,
        instructions: Optional[str] = None,
    ) -> dict:
        """
        Start analysis for a single video URL.

        Inserts a videos row (analyzed_at NULL = in-progress), spawns the
        analysis-worker subprocess in the background, and returns immediately
        with the video_id. Re-analysing the same URL for a creator reuses the
        existing video (re-runs idempotently). Poll get_video_analysis to track.

        instructions — optional free-text focus directive forwarded to the LLM
        analysis phase (e.g. "pay special attention to product placement and
        brand safety", or "evaluate pacing against a 60s TikTok brief"). Has no
        effect on the deterministic metrics phase.
        """
        if not source_url:
            raise ValueError("source_url is required")
        if not creator_id:
            raise ValueError("creator_id is required")

        video_id, created = db.get_or_create_video(creator_id, source_url)
        worker.spawn_analysis_worker(video_id, instructions=instructions)
        db.pg_notify_change(
            {"type": "video", "action": "created" if created else "updated", "video_id": video_id}
        )
        return {"video_id": video_id}

    @mcp.tool()
    def reanalyze_video(
        video_id: str,
        instructions: Optional[str] = None,
    ) -> dict:
        """
        Re-run the full analysis pipeline for a video that has already been analyzed.

        Clears the prior analysis (shots, frames, metrics) and starts a fresh
        worker run. Useful when:
        - You want to re-analyze with different focus instructions.
        - The pipeline has been updated and you want fresh results.
        - The previous run completed but produced poor results.

        Returns immediately with {video_id}. Poll get_video_analysis to track.

        instructions — optional focus directive for the LLM phase (same as
        analyze_video). Omit to re-run with default analysis behavior.
        """
        if not video_id:
            raise ValueError("video_id is required")
        video = db.get_video_analysis(video_id)
        if video is None:
            raise ValueError(f"No video found with id {video_id}")
        db.reset_video_for_reanalysis(video_id)
        worker.spawn_analysis_worker(video_id, instructions=instructions)
        db.pg_notify_change(
            {"type": "video", "action": "updated", "video_id": video_id}
        )
        return {"video_id": video_id}

    @mcp.tool()
    def analyze_channel(
        channel_url: str,
        kind: str,
        name: Optional[str] = None,
        max_videos: Optional[int] = None,
    ) -> dict:
        """
        Enumerate recent videos from a channel and start analysis for each.

        kind='self'      — the user's own channel (use for onboarding the user).
        kind='reference' — a competitor, role model, or inspiration channel.
                           Add freely; reference creators enrich ideation and comparison.

        Recommended max_videos: 5-10. That is usually enough for a solid style profile
        and avoids long waits. Each video takes 1-3 min; a full run takes 3-10 min.
        Hard cap is 20. Videos already tracked are skipped (no duplicate worker).

        After this call: poll get_channel_analysis(creator_id) until done==total,
        then call build_style_profile(creator_id) to generate the aggregated profile.
        The profile does NOT build automatically — you must trigger it.

        Returns {creator_id, video_ids}.
        """
        return start_channel_analysis(channel_url, kind, name, max_videos)

    @mcp.tool()
    def get_video_analysis(video_id: str) -> dict:
        """
        Return the current analysis status and results for a video.

        status is one of: 'running', 'done', 'failed'.
        analysis_stage is set while status='running' and shows which pipeline step
        is active: 'downloading', 'detecting_shots', 'extracting_frames',
        'transcribing', 'computing_metrics', 'analyzing_llm', 'persisting'.
        It is null when status is 'done' or 'failed'.
        Poll this tool to track progress — the stage lets you know whether the
        slow LLM step has started yet and roughly how far along analysis is.
        When done, video.metrics contains the derived style data.
        shots_summary lists every shot with idx, start_sec, end_sec, and frame_id.
        frame_id is a UUID; the representative frame image is served at /frames/{frame_id}.
        Use frame_id when building storyboard artifacts that reference shot thumbnails.

        Turning this into canvas blocks (see create_artifact for the full taxonomy):
        match each piece of the result to the block format that fits it — the hook → a
        text block with format:"title" titled "Hook"; each shot/scene → an image block
        (its frame_id) paired with a format:"title-sub" text block holding the scene
        label + timecode + description; transcript or freeform notes → format:"plain".
        """
        result = db.get_video_analysis(video_id)
        if result is None:
            raise ValueError(f"No video found with id {video_id}")
        return result

    @mcp.tool()
    def get_channel_analysis(creator_id: str) -> dict:
        """
        Return analysis progress for all videos belonging to a creator/channel.

        Poll this after analyze_channel to track progress. When done==total, all
        video analysis is complete and you should call build_style_profile(creator_id)
        to generate the aggregated style profile.

        Returns {videos: [{video_id, status}], done: int, total: int}.
        """
        videos = db.get_channel_videos(creator_id)
        done = sum(1 for v in videos if v["status"] == "done")
        return {"videos": videos, "done": done, "total": len(videos)}

    @mcp.tool()
    def get_video_shots(video_id: str) -> dict:
        """
        Return the full shot and frame list for a video, including per-shot analysis.

        Use this for deep-dive research or to build storyboard artifacts. Each shot
        has a representative frame (use get_frame(frame_id) to fetch the JPEG) and
        per-shot LLM analysis describing what the creator actually did visually.

        Each shot includes idx, start_sec, end_sec, frame_id, and:
          - analysis.deterministic: duration_sec, frame metrics, speech metrics
          - analysis.llm: shot_type, composition, subjects, palette, camera_movement,
            roll — vision-model output describing the shot

        frame_id is a UUID; fetch the JPEG with get_frame(frame_id) or reference it
        in image elements as src='/frames/{frame_id}'.

        Check get_video_analysis status first — shots array is empty while running.
        """
        full = db.get_video_full(video_id)
        if full is None:
            raise ValueError(f"No video found with id {video_id}")
        shots = [
            {
                "idx": s["idx"],
                "start_sec": float(s["start_sec"]),
                "end_sec": float(s["end_sec"]),
                "frame_id": str(s["frame_id"]) if s.get("frame_id") else None,
                "analysis": s.get("analysis"),
            }
            for s in full["shots"]
        ]
        return {"video_id": video_id, "shot_count": len(shots), "shots": shots}

    @mcp.tool()
    def get_frame(frame_id: str) -> dict:
        """
        Fetch a shot frame image as a base64 data URL.

        Returns {frame_id, mime_type, data_url, url}.
        data_url is a data:image/jpeg;base64,... string you can embed directly in
        image elements or HTML artifacts on the canvas.
        url is the /frames/{frame_id} path relative to the API base URL.

        Obtain frame_id values from get_video_shots or get_video_analysis shots_summary.
        """
        frame = db.get_frame(frame_id)
        if frame is None:
            raise ValueError(f"No frame found with id {frame_id}")
        data_b64 = base64.b64encode(frame["data"]).decode("ascii")
        return {
            "frame_id": frame_id,
            "mime_type": frame["mime_type"],
            "data_url": f"data:{frame['mime_type']};base64,{data_b64}",
            "url": f"/frames/{frame_id}",
        }


def start_channel_analysis(
    channel_url: str,
    kind: str,
    name: Optional[str] = None,
    max_videos: Optional[int] = None,
) -> dict:
    """Enumerate a channel and spawn analysis for each new video. Shared by the
    analyze_channel MCP tool and the POST /api/analyze-channel HTTP route.

    kind='self' reuses (and updates) the single self creator rather than inserting
    a duplicate; kind='reference' dedupes references on channel_url. Returns
    {creator_id, video_ids}. Raises ValueError on bad input, RuntimeError if
    channel enumeration (yt-dlp) fails.
    """
    if kind not in ("self", "reference"):
        raise ValueError("kind must be 'self' or 'reference'")
    if not channel_url:
        raise ValueError("channel_url is required")
    if max_videos is not None and max_videos < 1:
        raise ValueError("max_videos must be at least 1")

    limit = min(
        max_videos if max_videos is not None else settings.worker.max_channel_videos,
        MAX_CHANNEL_VIDEOS,
    )

    creator_name = name or channel_url
    if kind == "self":
        # Exactly one self creator: fill in the real channel on the placeholder.
        creator_id = db.get_or_create_self_creator()["creator_id"]
        db.update_creator(creator_id, name=creator_name, channel_url=channel_url)
    else:
        creator_id = db.find_or_create_creator("reference", creator_name, channel_url)[
            "creator_id"
        ]

    urls = _enumerate_channel(channel_url, limit)

    video_ids: list[str] = []
    for url in urls:
        vid_id, created = db.get_or_create_video(creator_id, url)
        video_ids.append(vid_id)
        if created:
            worker.spawn_analysis_worker(vid_id)
            db.pg_notify_change(
                {"type": "video", "action": "created", "video_id": vid_id}
            )

    return {"creator_id": creator_id, "video_ids": video_ids}


def _ytdlp_cookie_args() -> list[str]:
    """Same yt-dlp auth env as the worker's download step (analysis-worker/
    download.py): YTDLP_COOKIES_FILE or YTDLP_COOKIES_FROM_BROWSER. Needed to list
    walled accounts (e.g. Instagram). Returns [] when unset."""
    f = os.environ.get("YTDLP_COOKIES_FILE", "").strip()
    if f:
        return ["--cookies", f]
    b = os.environ.get("YTDLP_COOKIES_FROM_BROWSER", "").strip()
    if b:
        return ["--cookies-from-browser", b]
    return []


def _enumerate_channel(channel_url: str, max_videos: int) -> list[str]:
    """List the newest N video URLs from a channel via yt-dlp.

    Invoked as `sys.executable -m yt_dlp` so it always resolves to the
    venv-installed yt-dlp regardless of PATH.

    --lazy-playlist makes yt-dlp STOP once --playlist-end is reached instead of
    paginating the whole account first — that is what kept TikTok/Instagram
    listings from blowing the timeout (they're slow to fully enumerate). The
    timeout is just a backstop now; raise it with YTDLP_ENUM_TIMEOUT if needed.
    """
    timeout = int(os.environ.get("YTDLP_ENUM_TIMEOUT", "180"))
    cmd = [
        sys.executable,
        "-m",
        "yt_dlp",
        "--flat-playlist",
        "--lazy-playlist",
        "--playlist-end",
        str(max_videos),
        "--print",
        "url",
        *_ytdlp_cookie_args(),
        channel_url,
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        urls = [line.strip() for line in result.stdout.splitlines() if line.strip()]
        if not urls and result.stderr:
            raise RuntimeError(result.stderr.strip()[:500])
        return urls[:max_videos]
    except subprocess.TimeoutExpired:
        raise RuntimeError(
            f"Listing this channel timed out after {timeout}s — TikTok/Instagram can be "
            f"slow. Raise YTDLP_ENUM_TIMEOUT or lower max_videos."
        )
    except RuntimeError:
        raise
    except Exception as exc:
        raise RuntimeError(f"yt-dlp channel enumeration failed: {exc}") from exc
