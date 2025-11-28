-- Table to track deleted posts to avoid reprocessing
CREATE TABLE IF NOT EXISTS deleted_posts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_uri        TEXT UNIQUE NOT NULL,  -- The full URI of the deleted post
  mention_id      TEXT,  -- The mention_id that originally referenced this post
  author_id       TEXT NOT NULL,  -- Author of the deleted post
  post_id         TEXT NOT NULL,  -- The post ID portion only
  detected_at     TIMESTAMPTZ NOT NULL DEFAULT now(),  -- When we detected it was deleted
  retry_count     INTEGER DEFAULT 0,  -- How many times we tried to fetch it
  last_retry_at   TIMESTAMPTZ,  -- Last time we tried to fetch it
  metadata        JSONB  -- Additional metadata if needed
);

-- Indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_deleted_posts_uri ON deleted_posts(post_uri);
CREATE INDEX IF NOT EXISTS idx_deleted_posts_author ON deleted_posts(author_id);
CREATE INDEX IF NOT EXISTS idx_deleted_posts_detected ON deleted_posts(detected_at);
CREATE INDEX IF NOT EXISTS idx_deleted_posts_mention ON deleted_posts(mention_id);

-- Add new status for mentions table to indicate post was deleted
ALTER TABLE mentions
ADD COLUMN IF NOT EXISTS error_type TEXT;

-- Update the check constraint if you want to enforce specific status values
-- This is optional but recommended for data integrity
COMMENT ON COLUMN mentions.error_type IS 'Type of error: post_deleted, api_error, timeout, etc.';

-- Add a check constraint for valid error types (only if it doesn't exist)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'check_error_type'
    AND conrelid = 'mentions'::regclass
  ) THEN
    ALTER TABLE mentions
    ADD CONSTRAINT check_error_type CHECK (
      error_type IS NULL OR
      error_type IN ('post_deleted', 'api_error', 'timeout', 'network_error', 'validation_error')
    );
  END IF;
END $$;