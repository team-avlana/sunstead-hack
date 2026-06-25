"""
Style-profile aggregation entrypoint.

Env vars required:
  CREATOR_ID           — uuid of an existing creators row
  DB_CONNECTION_STRING — Postgres DSN (libpq format)
  ANTHROPIC_API_KEY    — Anthropic API key (or set AZURE_ANTHROPIC_URL + AZURE_ANTHROPIC_KEY)
"""

import sys
import traceback

import config
import db
import aggregate_metrics as agg
import profile_llm


def run(creator_id: str, dsn: str) -> None:
    conn = db.get_connection(dsn)
    try:
        # ── 1. Load creator + completed videos ──────────────────────────────
        print(f"[{creator_id}] Loading creator...")
        creator = db.load_creator(conn, creator_id)
        print(f"[{creator_id}] Creator: {creator['name']} ({creator.get('platform', 'unknown')})")

        print(f"[{creator_id}] Loading completed videos...")
        videos = db.load_completed_videos(conn, creator_id)
        print(f"[{creator_id}] {len(videos)} completed video(s) found")

        if not videos:
            print(f"[{creator_id}] No completed videos — nothing to profile. Exiting.")
            return

        # ── 2. Deterministic aggregation ────────────────────────────────────
        print(f"[{creator_id}] Aggregating deterministic metrics...")
        aggregates = agg.aggregate_deterministic(videos)

        # ── 3. Collect soft signals from videos.metrics.llm ─────────────────
        print(f"[{creator_id}] Collecting soft signals...")
        signals, truncated = agg.collect_soft_signals(videos)
        llm_covered = sum(1 for s in signals if not s.get("truncated"))
        print(f"[{creator_id}] {llm_covered} video(s) with full LLM detail")

        # ── 4. LLM synthesis ────────────────────────────────────────────────
        print(f"[{creator_id}] Synthesizing style profile (model: {config.LLM_SYNTHESIS_MODEL})...")
        style = profile_llm.synthesize_profile(creator, aggregates, signals, truncated)

        if not style:
            raise RuntimeError("LLM synthesis returned empty result")

        summary = style.get("style_summary", "")
        print(f"[{creator_id}] Synthesis complete. Summary: {summary[:120]}...")

        # ── 5. Persist new style_profiles row ───────────────────────────────
        profile_doc = {
            "metrics": aggregates,
            "style": style,
        }
        print(f"[{creator_id}] Inserting style profile...")
        profile_id = db.insert_style_profile(conn, creator_id, summary, profile_doc)
        print(f"[{creator_id}] Done. New style_profiles row: {profile_id}")

    except Exception as exc:
        msg = f"{type(exc).__name__}: {exc}"
        print(f"[{creator_id}] FAILED: {msg}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    config.validate_profile_env()
    try:
        run(config.CREATOR_ID, config.DB_CONNECTION_STRING)
    except Exception:
        sys.exit(1)
