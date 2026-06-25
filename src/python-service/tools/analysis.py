"""Analysis tools: trigger video/channel analysis and query progress."""

import json
import subprocess
import sys
from typing import Optional

from fastmcp import FastMCP

import db
import worker
from config import settings


def register(mcp: FastMCP) -> None:

    @mcp.tool()
    def analyze_video(source_url: str, creator_id: str) -> dict:
        """
        Start analysis for a single video URL.

        Inserts a videos row (analyzed_at NULL = in-progress), spawns the
        analysis-worker subprocess in the background, and returns immediately
        with the new video_id. Poll get_video_analysis to track progress.
        """
        if not source_url:
            raise ValueError("source_url is required")
        if not creator_id:
            raise ValueError("creator_id is required")

        video_id = db.insert_video(creator_id, source_url)
        worker.spawn_analysis_worker(video_id)
        # Signal the canvas (a block referencing this video flips to "analysing").
        db.pg_notify_change(
            {"type": "video", "action": "created", "video_id": video_id}
        )
        return {"video_id": video_id}

    @mcp.tool()
    def analyze_channel(
        channel_url: str,
        kind: str,
        name: Optional[str] = None,
    ) -> dict:
        """
        Enumerate recent videos from a channel and start analysis for each.

        kind must be 'self' (your own channel) or 'reference' (a competitor
        or inspiration channel). Creates/finds a creators row, enumerates up
        to max_channel_videos recent videos via yt-dlp, inserts a videos row
        per URL, and spawns one worker per video. Returns immediately.

        Returns {creator_id, video_ids}.
        """
        if kind not in ("self", "reference"):
            raise ValueError("kind must be 'self' or 'reference'")
        if not channel_url:
            raise ValueError("channel_url is required")

        creator_name = name or channel_url
        creator = db.find_or_create_creator(kind, creator_name, channel_url)
        creator_id = creator["creator_id"]

        urls = _enumerate_channel(channel_url, settings.worker.max_channel_videos)

        video_ids: list[str] = []
        for url in urls:
            vid_id = db.insert_video(creator_id, url)
            video_ids.append(vid_id)
            worker.spawn_analysis_worker(vid_id)
            db.pg_notify_change(
                {"type": "video", "action": "created", "video_id": vid_id}
            )

        return {"creator_id": creator_id, "video_ids": video_ids}

    @mcp.tool()
    def get_video_analysis(video_id: str) -> dict:
        """
        Return the current analysis status and results for a video.

        status is one of: 'running', 'done', 'failed'.
        When done, video.metrics contains the derived style data.
        shots_summary lists every shot with idx, start_sec, end_sec, and frame_id.
        frame_id is a UUID; the representative frame image is served at /frames/{frame_id}.
        Use frame_id when building storyboard artifacts that reference shot thumbnails.
        """
        result = db.get_video_analysis(video_id)
        if result is None:
            raise ValueError(f"No video found with id {video_id}")
        return result

    @mcp.tool()
    def get_channel_analysis(creator_id: str) -> dict:
        """
        Return analysis progress for all videos belonging to a creator/channel.

        Returns {videos: [{video_id, status}], done: int, total: int}.
        """
        videos = db.get_channel_videos(creator_id)
        done = sum(1 for v in videos if v["status"] == "done")
        return {"videos": videos, "done": done, "total": len(videos)}


def _enumerate_channel(channel_url: str, max_videos: int) -> list[str]:
    """Use yt-dlp --flat-playlist to list the newest N video URLs.

    Invoked as `sys.executable -m yt_dlp` so it always resolves to the
    venv-installed yt-dlp regardless of PATH.
    """
    try:
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "yt_dlp",
                "--flat-playlist",
                "--print",
                "url",
                "--playlist-end",
                str(max_videos),
                channel_url,
            ],
            capture_output=True,
            text=True,
            timeout=60,
        )
        urls = [line.strip() for line in result.stdout.splitlines() if line.strip()]
        if not urls and result.stderr:
            raise RuntimeError(result.stderr.strip()[:500])
        return urls[:max_videos]
    except RuntimeError:
        raise
    except Exception as exc:
        raise RuntimeError(f"yt-dlp channel enumeration failed: {exc}") from exc
