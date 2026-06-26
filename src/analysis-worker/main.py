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
from pathlib import Path

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

    try:
        # ── Phase A: init ────────────────────────────────────────────────────
        # Open connection only long enough to reset state and read the URL.
        with db.connect(dsn) as conn:
            db.clear_analysis_error(conn, video_id)
            video = db.load_video(conn, video_id)
            db.set_analysis_stage(conn, video_id, "downloading")
        source_url = video["source_url"]

        # ── 2. Acquire the file ───────────────────────────────────────────────
        # Uploaded deliveries already have the file on disk (local_path set by the
        # agency ingestion route) — probe it instead of running yt-dlp. Otherwise
        # download from the URL. No DB connection held (either can take minutes).
        existing_local = video.get("local_path")
        is_upload = str(source_url).startswith("upload://")
        if is_upload and existing_local and Path(existing_local).exists():
            print(f"[{video_id}] Using uploaded file {existing_local}")
            dl = download.probe_local(existing_local)
            # Prefer the original filename the uploader gave over the ffprobe stem.
            dl["title"] = video.get("title") or dl["title"]
        else:
            print(f"[{video_id}] Downloading {source_url} ...")
            dl = download.download_video(source_url, workdir)
        local_path = dl["local_path"]
        duration_sec = dl["duration_sec"]
        print(f"[{video_id}] Ready → {local_path} ({duration_sec:.1f}s)")

        # ── Phase B: post-download ───────────────────────────────────────────
        with db.connect(dsn) as conn:
            db.update_video_download_meta(
                conn, video_id,
                local_path=local_path,
                title=dl["title"],
                duration_sec=duration_sec,
                published_at=dl["published_at"],
                resolution=dl["resolution"],
                fps=dl["fps"],
            )
            db.set_analysis_stage(conn, video_id, "detecting_shots")

        # ── 3. Shot detection ────────────────────────────────────────────────
        print(f"[{video_id}] Detecting shots...")
        shot_list = scenes.detect_shots(local_path)
        print(f"[{video_id}] {len(shot_list)} shot(s) detected")

        with db.connect(dsn) as conn:
            db.set_analysis_stage(conn, video_id, "extracting_frames")

        # ── 4. Frame extraction ──────────────────────────────────────────────
        print(f"[{video_id}] Extracting frames...")
        shot_list = frames.extract_frames_for_shots(local_path, shot_list, frames_dir)

        with db.connect(dsn) as conn:
            db.set_analysis_stage(conn, video_id, "transcribing")

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

        with db.connect(dsn) as conn:
            db.set_analysis_stage(conn, video_id, "computing_metrics")

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
        # No DB connection held during LLM inference (the longest phase).
        llm_enabled = config.llm_enabled()

        video_llm: dict = {}
        if llm_enabled:
            with db.connect(dsn) as conn:
                db.set_analysis_stage(conn, video_id, "analyzing_llm")

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

        # ── Phase G: persist ─────────────────────────────────────────────────
        # All writes in one connection; shots/frames committed together.
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

        print(f"[{video_id}] Persisting {len(shot_list)} shot(s)...")
        with db.connect(dsn) as conn:
            db.set_analysis_stage(conn, video_id, "persisting")
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
            conn.commit()  # shots + frames atomically
            db.write_video_metrics(conn, video_id, video_metrics)
            db.set_analyzed_at(conn, video_id)
            db.notify_change(conn, video_id, "analysed")

        print(f"[{video_id}] Done.")

    except Exception as exc:
        msg = f"{type(exc).__name__}: {exc}"
        print(f"[{video_id}] FAILED: {msg}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        try:
            with db.connect(dsn) as conn:
                db.set_analysis_error(conn, video_id, msg)
                db.notify_change(conn, video_id, "error")
        except Exception:
            pass
        raise


if __name__ == "__main__":
    config.validate_env()
    try:
        run(config.VIDEO_ID, config.DB_CONNECTION_STRING)
    except Exception:
        sys.exit(1)
