from typing import Optional

from fastmcp import FastMCP

import db
import image_gen
import worker


def register(mcp: FastMCP) -> None:

    @mcp.tool()
    def list_creators(kind: Optional[str] = None) -> list:
        """
        List creator profiles. Call this FIRST at the start of every session.

        Find the creator with kind='self' — that is the user. Their creator_id is
        the anchor for get_style_profile, list_creator_videos, and get_channel_analysis.

        kind='self'      — the user's own channel (there is exactly one).
        kind='reference' — competitors, role models, or channels tracked for comparison.

        If kind is omitted, returns all creators. If no 'self' creator exists, ask the
        user for their channel URL and call analyze_channel(url, kind='self') to onboard them.

        Strongly suggest adding reference creators if none exist — comparison data makes
        ideation and positioning significantly richer.

        Returns [{creator_id, kind, name, platform, channel_url, created_at}].
        """
        if kind and kind not in ("self", "reference"):
            raise ValueError("kind must be 'self', 'reference', or omitted")
        return db.list_creators(kind=kind)

    @mcp.tool()
    def get_style_profile(creator_id: str) -> dict:
        """
        Return the latest style profile for a creator.

        The style profile is aggregated from all completed video analyses and captures
        the creator's tone of voice, pacing, shot composition patterns, recurring themes,
        energy level, and overall content DNA. It is the primary context reference for
        ideation, scripting, and storyboarding.

        Built by calling build_style_profile(creator_id) — this does NOT run automatically.
        You must trigger it manually after video analyses complete.

        Returns {summary, profile} or raises ValueError if no profile exists yet.
        If it raises, check whether video analyses are complete (get_channel_analysis) and
        then call build_style_profile to generate one.
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
        Trigger style-profile aggregation for a creator. MUST be called manually.

        This step is required after video analysis completes — the profile does NOT
        build automatically. Call it once all (or most) videos show status='done'
        in get_channel_analysis.

        Spawns build_profile.py as a background subprocess (fire-and-forget) and
        returns immediately. Poll get_style_profile(creator_id) to detect completion —
        a newer created_at on the returned profile means the build finished.

        Can be called again after adding more videos to regenerate an updated profile.
        Requires at least one completed video analysis for this creator.
        """
        creators = db.list_creators()
        if not any(str(c["creator_id"]) == creator_id for c in creators):
            raise ValueError(f"No creator found with id {creator_id}")
        worker.spawn_profile_builder(creator_id)
        return {"creator_id": creator_id, "status": "started"}

    @mcp.tool()
    def generate_room_image(creator_id: str) -> dict:
        """
        Generate a clay-diorama room image for a creator and save it to the database.

        Uses talking-head frames from the creator's analyzed videos (face + environment)
        and the bundled style reference to call gpt-image-1 via Azure AI Foundry.
        The resulting PNG is stored on the creators row and can be fetched via
        GET /api/creators/{creator_id}/room-image.

        Returns {creator_id, image_url} on success.
        Raises if AZURE_OPENAI_URL / AZURE_OPENAI_KEY are not configured,
        or if the creator does not exist.
        """
        creators = db.list_creators()
        if not any(str(c["creator_id"]) == creator_id for c in creators):
            raise ValueError(f"No creator found with id {creator_id}")

        png_bytes = image_gen.generate(creator_id)
        db.save_creator_room_image(creator_id, png_bytes, "image/png")

        return {
            "creator_id": creator_id,
            "image_url": f"/api/creators/{creator_id}/room-image",
        }

    @mcp.tool()
    def list_creator_videos(creator_id: str) -> dict:
        """
        List all videos for a creator/channel with metadata and analysis status.

        Call this at session start (after get_style_profile) to see what content
        has already been analyzed and to pick video_ids for deeper dives via
        get_video_analysis or get_video_shots.

        Returns {creator_id, videos:[{video_id, status, title, source_url,
        duration_sec, thumbnail}]} ordered newest first.

        status values:
          'analysing' — worker is still running
          'analysed'  — complete; full metrics and shots are available
          'error'     — analysis failed

        thumbnail is a /frames/{frame_id} path or null.

        Use get_video_analysis for a specific video's full metrics and shots summary.
        Use get_channel_analysis for a lightweight progress view (done/total counts).
        """
        videos = db.get_creator_videos(creator_id)
        if videos is None:
            raise ValueError(f"No creator found with id {creator_id}")
        return {"creator_id": creator_id, "videos": videos}
