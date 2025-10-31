-- Enable pgcrypto for gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- mentions: raw ingestion and processing state
CREATE TABLE mentions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mention_id      TEXT UNIQUE NOT NULL,
  post_id         TEXT NOT NULL,
  author_id       TEXT NOT NULL,
  content         TEXT NOT NULL,
  url             TEXT,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  status          TEXT NOT NULL DEFAULT 'received',  -- received|processing|completed|failed
  last_error      TEXT
);

CREATE INDEX idx_mentions_status ON mentions(status);
CREATE INDEX idx_mentions_received_at ON mentions(received_at);

-- action executions: when an action runs for a mention
CREATE TABLE action_executions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mention_id       TEXT NOT NULL REFERENCES mentions(mention_id) ON DELETE CASCADE,
  action_id        TEXT NOT NULL,  -- 'summary' | 'factcheck' | ...
  status           TEXT NOT NULL,  -- started|completed|failed
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at     TIMESTAMPTZ,
  metrics_json     JSONB,
  error_json       JSONB
);

CREATE INDEX idx_action_exec_mention ON action_executions(mention_id);
CREATE INDEX idx_action_exec_action ON action_executions(action_id);
CREATE INDEX idx_action_exec_status ON action_executions(status);

-- artifacts: stored outputs (summary, evidence, sources)
CREATE TABLE artifacts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action_execution_id UUID NOT NULL REFERENCES action_executions(id) ON DELETE CASCADE,
  type               TEXT NOT NULL, -- 'summary'|'evidence'|'sources'|...
  payload_json       JSONB NOT NULL
);

CREATE INDEX idx_artifacts_exec ON artifacts(action_execution_id);
CREATE INDEX idx_artifacts_type ON artifacts(type);

-- replies: published replies for auditability
CREATE TABLE replies (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mention_id    TEXT NOT NULL REFERENCES mentions(mention_id) ON DELETE CASCADE,
  parent_uri    TEXT NOT NULL,
  reply_uri     TEXT NOT NULL,
  content       TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_replies_mention ON replies(mention_id);
CREATE INDEX idx_replies_created_at ON replies(created_at);

-- routing decisions (optional audit trail)
CREATE TABLE routing_decisions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mention_id    TEXT NOT NULL REFERENCES mentions(mention_id) ON DELETE CASCADE,
  intent        TEXT NOT NULL, -- 'summary' | 'factcheck' | 'unknown'
  confidence    NUMERIC NOT NULL,
  reason        TEXT,
  decided_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_routing_decisions_mention ON routing_decisions(mention_id);
CREATE INDEX idx_routing_decisions_intent ON routing_decisions(intent);