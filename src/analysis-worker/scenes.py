import json
import subprocess

from scenedetect import open_video, SceneManager, StatsManager
from scenedetect.detectors import ContentDetector


def _video_duration_ffprobe(video_path: str) -> float:
    result = subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_streams", video_path],
        capture_output=True,
        text=True,
    )
    try:
        probe = json.loads(result.stdout)
        for stream in probe.get("streams", []):
            if stream.get("codec_type") == "video":
                return float(stream.get("duration", 0.0))
    except Exception:
        pass
    return 0.0


def detect_shots(video_path: str) -> list[dict]:
    """Detect shots with PySceneDetect ContentDetector.

    Returns list of dicts: {idx, start_sec, end_sec, content_score}.
    content_score is the maximum per-frame detector score within the shot,
    or None if stats were not captured.
    """
    stats_manager = StatsManager()
    video = open_video(video_path)
    manager = SceneManager(stats_manager=stats_manager)
    detector = ContentDetector()
    manager.add_detector(detector)
    manager.detect_scenes(video)

    scene_list = manager.get_scene_list()

    # Build per-frame score map from stats manager for content_score per shot
    frame_scores: dict[int, float] = {}
    try:
        for frame_num, metrics in stats_manager._frame_metrics.items():
            score = metrics.get("content_val", metrics.get("delta_lum", None))
            if score is not None:
                frame_scores[frame_num] = float(score)
    except Exception:
        pass

    shots = []
    for idx, (start_tc, end_tc) in enumerate(scene_list):
        start_sec = start_tc.get_seconds()
        end_sec = end_tc.get_seconds()

        # Max score in this shot's frame range
        start_fn = start_tc.get_frames()
        end_fn = end_tc.get_frames()
        shot_scores = [v for k, v in frame_scores.items() if start_fn <= k < end_fn]
        content_score = float(max(shot_scores)) if shot_scores else None

        shots.append({
            "idx": idx,
            "start_sec": start_sec,
            "end_sec": end_sec,
            "content_score": content_score,
        })

    # Treat entire video as a single shot if nothing was detected
    if not shots:
        duration = _video_duration_ffprobe(video_path)
        shots = [{"idx": 0, "start_sec": 0.0, "end_sec": duration, "content_score": None}]

    return shots
