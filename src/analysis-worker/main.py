"""
analysis-worker entrypoint.

Env vars required:
  VIDEO_ID             — uuid of an existing videos row
  DB_CONNECTION_STRING — Postgres DSN (libpq format)

Optional:
  AZURE_ANTHROPIC_URL  — Azure AI Foundry endpoint for Anthropic
  AZURE_ANTHROPIC_KEY  — Azure AI Foundry API key
  (without these two, LLM metrics are skipped)
"""

import sys
import traceback

import config
import db
import download
import scenes
import frames
import transcribe
import metrics_deterministic as det
import analyze_llm


def run(video_id: str, dsn: str) -> None:
    workdir = config.get_video_workdir(video_id)
    frames_dir = config.get_frames_dir(video_id)
    tmp_dir = config.get_tmp_dir(video_id)
    conn = db.get_connection(dsn)

    try:
        # Idempotency: clear previous error and delete any existing shots
        db.clear_analysis_error(conn, video_id)

        # ── 1. Load video row ────────────────────────────────────────────────
        print(f"[{video_id}] Loading video row...")
        video = db.load_video(conn, video_id)
        source_url = video["source_url"]

        # ── 2. Download ──────────────────────────────────────────────────────
        print(f"[{video_id}] Downloading {source_url} ...")
        dl = download.download_video(source_url, workdir)
        local_path = dl["local_path"]
        duration_sec = dl["duration_sec"]
        db.update_video_download_meta(
            conn, video_id,
            local_path=local_path,
            title=dl["title"],
            duration_sec=duration_sec,
            published_at=dl["published_at"],
            resolution=dl["resolution"],
            fps=dl["fps"],
        )
        print(f"[{video_id}] Downloaded → {local_path} ({duration_sec:.1f}s)")

        # ── 3. Shot detection ────────────────────────────────────────────────
        print(f"[{video_id}] Detecting shots...")
        shot_list = scenes.detect_shots(local_path)
        print(f"[{video_id}] {len(shot_list)} shot(s) detected")

        # ── 4. Frame extraction ──────────────────────────────────────────────
        print(f"[{video_id}] Extracting frames...")
        shot_list = frames.extract_frames_for_shots(local_path, shot_list, frames_dir)

        # ── 5. Transcription ─────────────────────────────────────────────────
        print(f"[{video_id}] Transcribing...")
        try:
            transcript = transcribe.transcribe(local_path, tmp_dir)
            print(f"[{video_id}] Transcript: {len(transcript.get('words', []))} words")
        except Exception as exc:
            print(f"[{video_id}] Transcription failed ({exc}) — continuing with empty transcript")
            transcript = {"text": "", "segments": [], "words": []}

        for shot in shot_list:
            shot["transcript_slice"] = transcribe.slice_transcript_for_shot(
                transcript, shot["start_sec"], shot["end_sec"]
            )

        # ── 6. Deterministic metrics ─────────────────────────────────────────
        print(f"[{video_id}] Computing deterministic metrics...")
        for shot in shot_list:
            frame_m = det.compute_frame_metrics(shot.get("frame_bytes"))
            speech_m = det.compute_shot_speech_metrics(
                shot["transcript_slice"], shot["end_sec"] - shot["start_sec"]
            )
            shot["frame_width"] = frame_m.get("width")
            shot["frame_height"] = frame_m.get("height")
            shot["analysis"] = {
                "deterministic": {
                    "duration_sec": round(shot["end_sec"] - shot["start_sec"], 3),
                    "frame": frame_m,
                    "speech": speech_m,
                }
            }

        # ── 7. LLM metrics ───────────────────────────────────────────────────
        llm_enabled = config.llm_enabled()

        video_llm: dict = {}
        if llm_enabled:
            print(f"[{video_id}] Running per-shot LLM analysis ({len(shot_list)} shots)...")
            for shot in shot_list:
                try:
                    shot["analysis"]["llm"] = analyze_llm.analyze_shot(
                        shot.get("frame_bytes"),
                        shot["transcript_slice"],
                        shot["idx"],
                    )
                except Exception as exc:
                    print(f"[{video_id}]   shot {shot['idx']} LLM failed: {exc}")
                    shot["analysis"]["llm"] = {"error": str(exc)[:300]}

            print(f"[{video_id}] Running video-level LLM synthesis...")
            try:
                video_llm = analyze_llm.analyze_video_level(transcript, shot_list, duration_sec)
            except Exception as exc:
                print(f"[{video_id}] Video-level LLM failed: {exc}")
                video_llm = {"error": str(exc)[:300]}
        else:
            print(f"[{video_id}] LLM skipped (AZURE_ANTHROPIC_URL/KEY not set)")

        # ── 8. Persist ───────────────────────────────────────────────────────
        print(f"[{video_id}] Persisting {len(shot_list)} shot(s)...")
        db.delete_existing_shots(conn, video_id)  # cascades to frames
        for shot in shot_list:
            shot_id = db.insert_shot(
                conn,
                video_id=video_id,
                idx=shot["idx"],
                start_sec=shot["start_sec"],
                end_sec=shot["end_sec"],
                analysis=shot["analysis"],
            )
            if shot.get("frame_bytes"):
                db.insert_frame(
                    conn,
                    shot_id=shot_id,
                    video_id=video_id,
                    timestamp_sec=shot["frame_ts"],
                    data=shot["frame_bytes"],
                    width=shot.get("frame_width"),
                    height=shot.get("frame_height"),
                )
        conn.commit()

        video_metrics = {
            "deterministic": det.compute_video_deterministic_metrics(
                shot_list, transcript, duration_sec
            ),
            "llm": video_llm,
            "transcript": {
                "text": transcript.get("text", ""),
                "segments": transcript.get("segments", []),
                "words": transcript.get("words", []),
            },
        }
        db.write_video_metrics(conn, video_id, video_metrics)
        db.set_analyzed_at(conn, video_id)
        conn.commit()
        db.notify_change(conn, video_id, "analysed")

        print(f"[{video_id}] Done.")

    except Exception as exc:
        msg = f"{type(exc).__name__}: {exc}"
        print(f"[{video_id}] FAILED: {msg}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        try:
            db.set_analysis_error(conn, video_id, msg)
            db.notify_change(conn, video_id, "error")
        except Exception:
            pass
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    config.validate_env()
    try:
        run(config.VIDEO_ID, config.DB_CONNECTION_STRING)
    except Exception:
        sys.exit(1)
