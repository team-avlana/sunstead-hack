"""Analysis tools: trigger video/channel analysis and query progress."""

import base64
import json
import subprocess
import sys
from typing import Optional

from fastmcp import FastMCP

import db
import worker
from config import MAX_CHANNEL_VIDEOS, settings


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

        video_id, created = db.find_or_create_video(creator_id, source_url)
        worker.spawn_analysis_worker(video_id)
        db.pg_notify_change(
            {"type": "video", "action": "created" if created else "updated", "video_id": video_id}
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

        kind must be 'self' (your own channel) or 'reference' (a competitor
        or inspiration channel). Creates/finds a creators row, enumerates up
        to max_videos recent videos via yt-dlp, inserts a videos row per URL,
        and spawns one worker per video. Returns immediately.

        max_videos defaults to the server's configured default (5) and is
        capped at 20. Videos that are already tracked are skipped (no duplicate
        worker is spawned).

        Returns {creator_id, video_ids}.
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
        creator = db.find_or_create_creator(kind, creator_name, channel_url)
        creator_id = creator["creator_id"]

        urls = _enumerate_channel(channel_url, limit)

        video_ids: list[str] = []
        for url in urls:
            vid_id, created = db.find_or_create_video(creator_id, url)
            video_ids.append(vid_id)
            if created:
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

    @mcp.tool()
    def get_video_shots(video_id: str) -> dict:
        """
        Return the full shot and frame list for a video, including per-shot analysis.

        Each shot includes idx, start_sec, end_sec, frame_id, and the complete
        analysis data:
          - analysis.deterministic: duration_sec, frame metrics, speech metrics
          - analysis.llm: shot_type, composition, subjects, palette, camera_movement,
            roll, subject — the vision model output per shot

        frame_id is a UUID; fetch the JPEG thumbnail with get_frame or at
        /frames/{frame_id}. Use get_video_analysis to check status first — shots
        are empty while analysis is still running.
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
