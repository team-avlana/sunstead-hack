from typing import Optional

from fastmcp import FastMCP

import db
import worker


def register(mcp: FastMCP) -> None:

    @mcp.tool()
    def list_creators(kind: Optional[str] = None) -> list:
        """
        List creator profiles. Optionally filter by kind ('self' or 'reference').
        Returns [{creator_id, kind, name, platform, channel_url, created_at}].
        """
        if kind and kind not in ("self", "reference"):
            raise ValueError("kind must be 'self', 'reference', or omitted")
        return db.list_creators(kind=kind)

    @mcp.tool()
    def get_style_profile(creator_id: str) -> dict:
        """
        Return the latest style profile for a creator.

        The style profile is built by the separate aggregation script from
        completed video analyses. Returns {summary, profile} or raises if
        no profile exists yet.
        """
        result = db.get_style_profile(creator_id)
        if result is None:
            raise ValueError(
                f"No style profile found for creator {creator_id}. "
                "Run the style-profile aggregation script first."
            )
        return result

    @mcp.tool()
    def build_style_profile(creator_id: str) -> dict:
        """
        Trigger style-profile aggregation for a creator.

        Spawns build_profile.py as a background subprocess (fire-and-forget).
        Returns immediately. Poll get_style_profile to check when the new
        profile version appears — a newer created_at on the style_profiles row
        means the build completed successfully.

        Requires at least one completed video analysis for this creator.
        """
        creators = db.list_creators()
        if not any(str(c["creator_id"]) == creator_id for c in creators):
            raise ValueError(f"No creator found with id {creator_id}")
        worker.spawn_profile_builder(creator_id)
        return {"creator_id": creator_id, "status": "started"}

    @mcp.tool()
    def list_creator_videos(creator_id: str) -> dict:
        """
        List all videos for a creator/channel with metadata and analysis status.

        Returns {creator_id, videos:[{video_id, status, title, source_url,
        duration_sec, thumbnail}]} ordered newest first.

        status is one of: 'analysing', 'analysed', 'error'.
        thumbnail is a /frames/{frame_id} path or null — pass to resolveAssetUrl
        on the canvas or use get_frame to fetch the image bytes.

        Use get_video_analysis for a specific video's full metrics and shots.
        Use get_channel_analysis for a lightweight progress dashboard (done/total counts).
        """
        videos = db.get_creator_videos(creator_id)
        if videos is None:
            raise ValueError(f"No creator found with id {creator_id}")
        return {"creator_id": creator_id, "videos": videos}
