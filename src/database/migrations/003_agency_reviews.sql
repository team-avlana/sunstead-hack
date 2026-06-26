-- Migration 003: agency UGC review loop (dashboard surface)
-- Adds the `reviews` operational record and a 'talent' creator kind for the
-- agency roster. The schema.sql canonical source already includes both.
-- Idempotent / safe to run against an existing DB.

-- 1. Allow a third creator kind: 'talent' (a UGC creator on the agency roster).
ALTER TABLE creators DROP CONSTRAINT IF EXISTS creators_kind_check;
ALTER TABLE creators ADD CONSTRAINT creators_kind_check
    CHECK (kind IN ('self', 'reference', 'talent'));

-- 2. The reviews table.
CREATE TABLE IF NOT EXISTS reviews (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id          uuid NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    delivery_video_id   uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    reference_video_id  uuid REFERENCES videos(id) ON DELETE SET NULL,

    brief_title         text,
    brief               text,

    status              text NOT NULL DEFAULT 'analyzing'
                            CHECK (status IN ('analyzing', 'ready', 'failed')),
    verdict             text CHECK (verdict IN ('approve', 'revise', 'reshoot')),
    overall_score       int,
    scores              jsonb,
    dimensions          jsonb,
    strengths           jsonb,
    missing             jsonb,
    note                text,
    error               text,

    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    deleted_at          timestamptz
);

CREATE INDEX IF NOT EXISTS idx_reviews_creator ON reviews (creator_id, created_at DESC)
    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_reviews_delivery ON reviews (delivery_video_id)
    WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_reviews_touch ON reviews;
CREATE TRIGGER trg_reviews_touch
    BEFORE UPDATE ON reviews
    FOR EACH ROW EXECUTE FUNCTION touch_timestamps();
