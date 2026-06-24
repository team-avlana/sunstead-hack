# Data Model (working draft)

_Last updated: 2026-06-24._ Rainy downloads videos and analyzes them locally, so the model is
**media-centric**, not stats-centric. Shared **SQLite (WAL)** store; both the Swift app (GRDB) and
the Python sidecar (sqlite3/SQLModel) read/write it. Swift owns migrations.

## Entities

```
Creator ──< Video ──< Scene ──< Keyframe
   │           │         │
   │           │         └──< SceneAnalysis (VLM result)
   │           └──< VideoAnalysis (aggregate: topic, hook, pacing, summary)
   │
Project ──< CanvasNode >──< CanvasEdge       (the infinite canvas)
              │
              └─ may reference any of: Creator | Video | Scene | Analysis
```

| Entity | Key fields | Notes |
|--------|-----------|-------|
| **Creator** | id, platform (`youtube`/`tiktok`/`instagram`), handle, url, display_name, is_self (own vs competitor), niche/tags | The channels the user links |
| **Video** | id, creator_id, platform_id, url, title, description, published_at, duration, stats_json (views/likes if captured), local_path, thumbnail_path, download_status, downloaded_at | `stats_json` is whatever yt-dlp metadata gives |
| **Scene** | id, video_id, index, start_tc, end_tc, start_frame, end_frame, keyframe_path | From PySceneDetect |
| **Keyframe** | id, scene_id, frame_number, timestamp, image_path | Representative frame(s) per scene fed to the VLM |
| **SceneAnalysis** | id, scene_id, model (`fm-v3`/`claude-…`), description, labels_json, ocr_text, created_at | Per-scene VLM/Vision output |
| **VideoAnalysis** | id, video_id, hook, structure, pacing, topics_json, transcript, summary, outlier_score, model, created_at | Aggregate analysis |
| **Project** | id, name, created_at, updated_at | A canvas/brainstorm workspace |
| **CanvasNode** | id, project_id, type, x, y, w, h, z, payload_json, ref_kind, ref_id | World coords; `ref_*` links to a Creator/Video/Scene/Analysis |
| **CanvasEdge** | id, project_id, from_node_id, to_node_id, kind, label | Connections between nodes |
| **Job** | id, kind (`download`/`scene_detect`/`analyze`), target_ref, status, progress, error, created_at | Pipeline task tracking for UI/menu-bar status |

## Pipeline → data flow

1. **Link** a creator/video → `Creator` / `Video` rows (status `pending`).
2. **Download** (`yt-dlp`, sidecar) → fills `Video.local_path`, `thumbnail_path`, `stats_json`; `Job` tracks progress.
3. **Scene-detect** (PySceneDetect) → `Scene` rows + `Keyframe` images.
4. **Transcribe** (SpeechAnalyzer, app side) → `VideoAnalysis.transcript`.
5. **VLM analyze** keyframes → `SceneAnalysis` (FM on-device or Claude vision per D13) → roll up into `VideoAnalysis`.
6. **Insights**: compare performance, find outliers (`outlier_score`), explore similar creators — derived queries over the above.
7. **Canvas**: agent (Claude Code / fast model) reads these and writes `CanvasNode`/`CanvasEdge` live.

## Open
- OQ7 retention of large `local_path` files. OQ8 which Claude model for heavy VLM.
- Embeddings for "similar creators"/niche outliers? (Add a `vector`/`embedding` table later — likely
  sqlite-vec or a local index.) Tracked when we get to insights.
