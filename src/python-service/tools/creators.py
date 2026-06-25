from typing import Optional

from fastmcp import FastMCP

import db


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

    # TODO: stub for future aggregation trigger
    # @mcp.tool()
    # def build_style_profile(creator_id: str) -> dict:
    #     """Trigger style-profile aggregation for a creator (not yet implemented)."""
    #     raise NotImplementedError("Style profile aggregation script is a separate task.")
