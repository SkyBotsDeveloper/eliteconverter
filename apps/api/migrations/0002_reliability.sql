ALTER TABLE conversion_jobs ADD COLUMN access_token_hash TEXT;
ALTER TABLE conversion_jobs ADD COLUMN output_url_private TEXT;
ALTER TABLE conversion_jobs ADD COLUMN output_url_redacted TEXT;
ALTER TABLE conversion_jobs ADD COLUMN callback_url_private TEXT;
ALTER TABLE conversion_jobs ADD COLUMN callback_url_redacted TEXT;
ALTER TABLE conversion_jobs ADD COLUMN next_poll_at TEXT;
ALTER TABLE conversion_jobs ADD COLUMN poll_attempt_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_conversion_jobs_next_poll
  ON conversion_jobs(next_poll_at)
  WHERE next_poll_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  job_id TEXT,
  payload_json TEXT NOT NULL,
  run_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','processing','completed','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  dedupe_key TEXT NOT NULL UNIQUE,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due
  ON scheduled_tasks(status, run_at);

CREATE TABLE IF NOT EXISTS queue_message_deliveries (
  dedupe_key TEXT PRIMARY KEY,
  processed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS client_webhook_events (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  callback_url_private TEXT NOT NULL,
  callback_url_redacted TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','delivering','delivered','retrying','permanently_failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_status_code INTEGER,
  last_error TEXT,
  next_attempt_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES conversion_jobs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_client_webhook_events_due
  ON client_webhook_events(status, next_attempt_at);
