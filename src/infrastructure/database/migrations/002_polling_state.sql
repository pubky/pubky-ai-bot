-- Polling state: persistent storage for mention polling offset
-- Addresses: Architecture Review Critical Issue #2 - Offset State Management
CREATE TABLE IF NOT EXISTS polling_state (
  poller_id       TEXT PRIMARY KEY,
  last_offset     INTEGER NOT NULL DEFAULT 0,
  last_poll_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Initialize default poller state
INSERT INTO polling_state (poller_id, last_offset, last_poll_at, updated_at)
VALUES ('nexus_mention_poller', 0, now(), now())
ON CONFLICT (poller_id) DO NOTHING;

-- Index for monitoring polling activity
CREATE INDEX IF NOT EXISTS idx_polling_state_updated_at ON polling_state(updated_at);
