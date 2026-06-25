-- ============================================================================
--  Video Preproduction Assistant — database schema
--  Postgres 13+  (uses gen_random_uuid() from pgcrypto)
--
--  Conventions for ALL tables:
--    created_at  timestamptz NOT NULL  -- set on insert, NOT updatable (trigger)
--    updated_at  timestamptz NOT NULL  -- auto-bumped on every UPDATE (trigger)
--    deleted_at  timestamptz NULL      -- soft delete; NULL = live row
--
--  Single source of truth for the read-only canvas and the agent.
--  The analysis "pyramid": shots (raw) -> videos.metrics (derived)
--  -> style_profiles (compact, context-ready).
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
--  Shared timestamp trigger
--  - preserves created_at on UPDATE (effectively read-only after insert)
--  - sets updated_at = now() on every UPDATE
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION touch_timestamps()
RETURNS trigger AS $$
BEGIN
    NEW.created_at := OLD.created_at;  -- never allow created_at to change
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
--  PROJECTS — one preproduction project == one canvas
-- ============================================================================
CREATE TABLE projects (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL,

    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    deleted_at  timestamptz
);

CREATE TRIGGER trg_projects_touch
    BEFORE UPDATE ON projects
    FOR EACH ROW EXECUTE FUNCTION touch_timestamps();

-- ============================================================================
--  CREATORS — global (not project-scoped). The user's own channel + references.
-- ============================================================================
CREATE TABLE creators (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind         text NOT NULL CHECK (kind IN ('self', 'reference')),
    name         text NOT NULL,
    platform     text,                 -- youtube / tiktok / instagram / ...
    channel_url  text,

    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    deleted_at   timestamptz
);

CREATE TRIGGER trg_creators_touch
    BEFORE UPDATE ON creators
    FOR EACH ROW EXECUTE FUNCTION touch_timestamps();

-- ============================================================================
--  VIDEOS — one row per analyzed video. Holds the DERIVED metrics layer.
--  Row is inserted when analysis STARTS (created_at = start);
--  analyzed_at is set when it COMPLETES. analyzed_at IS NULL => in progress,
--  unless analysis_error is set => failed.
-- ============================================================================
CREATE TABLE videos (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id      uuid NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    source_url      text NOT NULL,
    title           text,
    duration_sec    numeric,
    local_path      text,              -- path to the downloaded file
    metrics         jsonb,             -- derived: cut_frequency, avg_shot_len,
                                       -- shot_count, motion, pacing_curve, ...
    published_at    timestamptz,
    analyzed_at     timestamptz,       -- NULL until analysis completes
    analysis_error  text,              -- non-NULL => analysis failed

    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    deleted_at      timestamptz
);

CREATE UNIQUE INDEX idx_videos_url ON videos (creator_id, source_url) WHERE deleted_at IS NULL;
CREATE INDEX idx_videos_creator ON videos (creator_id) WHERE deleted_at IS NULL;

CREATE TRIGGER trg_videos_touch
    BEFORE UPDATE ON videos
    FOR EACH ROW EXECUTE FUNCTION touch_timestamps();

-- ============================================================================
--  SHOTS — RAW layer. One row per PySceneDetect shot, one frame each.
--  Shot length is derived: end_sec - start_sec.
-- ============================================================================
CREATE TABLE shots (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    video_id    uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    idx         int NOT NULL,          -- shot order within the video
    start_sec   numeric NOT NULL,
    end_sec     numeric NOT NULL,
    analysis    jsonb,                 -- vision output: shot_type, composition,
                                       -- subjects, palette, camera_movement, ...

    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    deleted_at  timestamptz,

    UNIQUE (video_id, idx)
);

CREATE INDEX idx_shots_video ON shots (video_id, idx) WHERE deleted_at IS NULL;

CREATE TRIGGER trg_shots_touch
    BEFORE UPDATE ON shots
    FOR EACH ROW EXECUTE FUNCTION touch_timestamps();

-- ============================================================================
--  FRAMES — one representative JPEG frame per shot, stored as raw bytes.
--  Keyed by shot; cascade-deletes when the shot is deleted.
--  The canvas fetches frames via GET /frames/{id}.
-- ============================================================================
CREATE TABLE frames (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    shot_id       uuid NOT NULL REFERENCES shots(id) ON DELETE CASCADE,
    video_id      uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    timestamp_sec float NOT NULL,      -- position in the video this frame was taken from
    data          bytea NOT NULL,      -- raw JPEG bytes
    mime_type     text NOT NULL DEFAULT 'image/jpeg',
    width         integer,
    height        integer,

    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_frames_shot    ON frames (shot_id);
CREATE INDEX idx_frames_video   ON frames (video_id);

-- ============================================================================
--  STYLE_PROFILES — PROFILE layer. Compact, context-ready. Versioned:
--  keep history, read the latest per creator.
-- ============================================================================
CREATE TABLE style_profiles (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id  uuid NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    summary     text,                  -- prose that drops straight into context
    profile     jsonb,                 -- structured aggregates: typical pacing,
                                       -- palette, recurring shot types, hooks, ...

    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    deleted_at  timestamptz
);

-- "latest profile per creator" lookup
CREATE INDEX idx_style_profiles_creator_latest
    ON style_profiles (creator_id, created_at DESC)
    WHERE deleted_at IS NULL;

CREATE TRIGGER trg_style_profiles_touch
    BEFORE UPDATE ON style_profiles
    FOR EACH ROW EXECUTE FUNCTION touch_timestamps();

-- ============================================================================
--  ARTIFACTS — every artifact is a FRAME (a flow); the blocks it contains live
--  INSIDE payload.elements. The canvas is a pure projection of these rows: one
--  frame → a tldraw frame, each element → a block (text | video | …) within it.
--  Element ids live in the payload so the agent can address a single block:
--  update_artifact(id, element_id, element_patch).
-- ============================================================================
CREATE TABLE artifacts (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    type        text NOT NULL,         -- MVP: 'frame'. The block kind lives in
                                       -- payload.elements[].type (text | video).
    title       text,
    payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
                                       -- {label, role?, elements:[
                                       --   {id, type, x, y, w, h, ...}]}
    position    jsonb,                 -- {x, y, w, h} frame box on the canvas
    z           int NOT NULL DEFAULT 0,-- stacking order
    version     int NOT NULL DEFAULT 1,-- bump on update; cheap change detection

    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    deleted_at  timestamptz
);

CREATE INDEX idx_artifacts_project ON artifacts (project_id) WHERE deleted_at IS NULL;

CREATE TRIGGER trg_artifacts_touch
    BEFORE UPDATE ON artifacts
    FOR EACH ROW EXECUTE FUNCTION touch_timestamps();

-- ============================================================================
--  MEMORY — Q&A-derived context + freeform notes.
--  project_id NULL => user-level memory (spans projects, e.g. style prefs).
-- ============================================================================
CREATE TABLE memory (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id  uuid REFERENCES projects(id) ON DELETE CASCADE,  -- NULL = user-level
    kind        text NOT NULL,         -- goal | audience | platform |
                                       -- constraint | preference | note
    key         text,                  -- optional label
    value       text,                  -- human-readable fact
    data        jsonb,                 -- optional structured form

    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    deleted_at  timestamptz
);

CREATE INDEX idx_memory_project ON memory (project_id) WHERE deleted_at IS NULL;

CREATE TRIGGER trg_memory_touch
    BEFORE UPDATE ON memory
    FOR EACH ROW EXECUTE FUNCTION touch_timestamps();
