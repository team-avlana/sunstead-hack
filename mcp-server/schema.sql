-- Rainy shared store. See ../docs/DATA_MODEL.md.
-- WAL + busy_timeout so the Swift app (GRDB) and this sidecar can both write safely.
-- NOTE: Swift (GRDB) owns migrations in production; this file is the reference schema
-- and lets the sidecar bootstrap a DB during standalone development.
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS creator (
    id           TEXT PRIMARY KEY,
    platform     TEXT NOT NULL CHECK (platform IN ('youtube','tiktok','instagram')),
    handle       TEXT NOT NULL,
    url          TEXT,
    display_name TEXT,
    is_self      INTEGER NOT NULL DEFAULT 0,
    niche        TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS video (
    id              TEXT PRIMARY KEY,
    creator_id      TEXT REFERENCES creator(id) ON DELETE CASCADE,
    platform_id     TEXT,
    url             TEXT NOT NULL,
    title           TEXT,
    description     TEXT,
    published_at    TEXT,
    duration        REAL,
    stats_json      TEXT,
    local_path      TEXT,
    thumbnail_path  TEXT,
    download_status TEXT NOT NULL DEFAULT 'pending',
    downloaded_at   TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scene (
    id           TEXT PRIMARY KEY,
    video_id     TEXT NOT NULL REFERENCES video(id) ON DELETE CASCADE,
    idx          INTEGER NOT NULL,
    start_tc     REAL,
    end_tc       REAL,
    start_frame  INTEGER,
    end_frame    INTEGER,
    keyframe_path TEXT
);

CREATE TABLE IF NOT EXISTS scene_analysis (
    id          TEXT PRIMARY KEY,
    scene_id    TEXT NOT NULL REFERENCES scene(id) ON DELETE CASCADE,
    model       TEXT,
    description TEXT,
    labels_json TEXT,
    ocr_text    TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS video_analysis (
    id            TEXT PRIMARY KEY,
    video_id      TEXT NOT NULL REFERENCES video(id) ON DELETE CASCADE,
    hook          TEXT,
    structure     TEXT,
    pacing        TEXT,
    topics_json   TEXT,
    transcript    TEXT,
    summary       TEXT,
    outlier_score REAL,
    model         TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS project (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS canvas_node (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    type        TEXT NOT NULL DEFAULT 'note',
    x           REAL NOT NULL DEFAULT 0,
    y           REAL NOT NULL DEFAULT 0,
    w           REAL NOT NULL DEFAULT 200,
    h           REAL NOT NULL DEFAULT 120,
    z           INTEGER NOT NULL DEFAULT 0,
    payload_json TEXT,
    ref_kind    TEXT,
    ref_id      TEXT,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS canvas_edge (
    id           TEXT PRIMARY KEY,
    project_id   TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    from_node_id TEXT NOT NULL REFERENCES canvas_node(id) ON DELETE CASCADE,
    to_node_id   TEXT NOT NULL REFERENCES canvas_node(id) ON DELETE CASCADE,
    kind         TEXT,
    label        TEXT
);

CREATE TABLE IF NOT EXISTS job (
    id         TEXT PRIMARY KEY,
    kind       TEXT NOT NULL,
    target_ref TEXT,
    status     TEXT NOT NULL DEFAULT 'pending',
    progress   REAL NOT NULL DEFAULT 0,
    error      TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_video_creator ON video(creator_id);
CREATE INDEX IF NOT EXISTS idx_scene_video   ON scene(video_id);
CREATE INDEX IF NOT EXISTS idx_node_project  ON canvas_node(project_id);
CREATE INDEX IF NOT EXISTS idx_edge_project  ON canvas_edge(project_id);
