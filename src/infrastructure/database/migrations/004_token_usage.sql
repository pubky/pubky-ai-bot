-- Track LLM token usage per mention and per user (pubkey)
-- This enables per-user budgeting and usage reporting

CREATE TABLE IF NOT EXISTS token_usage (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mention_id      TEXT NOT NULL REFERENCES mentions(mention_id) ON DELETE CASCADE,
  public_key      TEXT NOT NULL,
  phase           TEXT NOT NULL, -- e.g., 'summary', 'factcheck_extract', 'factcheck_verify'
  provider        TEXT,
  model           TEXT,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  total_tokens    INTEGER,
  meta_json       JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_token_usage_mention ON token_usage(mention_id);
CREATE INDEX IF NOT EXISTS idx_token_usage_pubkey_created ON token_usage(public_key, created_at);
CREATE INDEX IF NOT EXISTS idx_token_usage_phase ON token_usage(phase);

