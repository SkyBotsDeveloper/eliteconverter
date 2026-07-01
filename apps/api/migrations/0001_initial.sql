PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  scopes TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  last_used_at TEXT,
  FOREIGN KEY (owner_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS conversion_jobs (
  id TEXT PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  owner_id TEXT,
  anonymous_session_id TEXT,
  api_key_id TEXT,
  input_url TEXT NOT NULL,
  input_url_redacted TEXT NOT NULL,
  source_hostname TEXT NOT NULL,
  format TEXT NOT NULL,
  quality TEXT NOT NULL,
  status TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  current_stage TEXT NOT NULL,
  provider_id TEXT,
  provider_job_id TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  provider_attempt_count INTEGER NOT NULL DEFAULT 0,
  public_error_code TEXT,
  public_error_message TEXT,
  internal_diagnostic TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  completed_at TEXT,
  output_url TEXT,
  output_url_expires_at TEXT,
  output_mime_type TEXT,
  output_file_size INTEGER,
  idempotency_key TEXT,
  request_fingerprint TEXT,
  callback_url TEXT,
  cancellation_state TEXT,
  CHECK (status IN ('pending','validating','queued','submitting','submitted','processing','retrying','completed','failed','cancel_requested','cancelled','expired'))
);

CREATE INDEX IF NOT EXISTS idx_conversion_jobs_status ON conversion_jobs(status);
CREATE INDEX IF NOT EXISTS idx_conversion_jobs_owner ON conversion_jobs(owner_id);
CREATE INDEX IF NOT EXISTS idx_conversion_jobs_api_key ON conversion_jobs(api_key_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversion_jobs_idempotency ON conversion_jobs(api_key_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS conversion_job_events (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  public_job_id TEXT NOT NULL,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  safe_details TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES conversion_jobs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_conversion_job_events_job ON conversion_job_events(job_id, created_at);

CREATE TABLE IF NOT EXISTS provider_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  provider_job_id TEXT,
  error_code TEXT,
  retryable INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  FOREIGN KEY (job_id) REFERENCES conversion_jobs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS provider_health (
  provider_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('closed','open','half_open')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  recent_successes INTEGER NOT NULL DEFAULT 0,
  recent_failures INTEGER NOT NULL DEFAULT 0,
  last_failure_at TEXT,
  cooldown_until TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_webhook_events (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  provider_job_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  received_at TEXT NOT NULL,
  UNIQUE (provider_id, provider_event_id)
);

CREATE TABLE IF NOT EXISTS client_webhook_deliveries (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  callback_url_redacted TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_status_code INTEGER,
  next_attempt_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES conversion_jobs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS usage_records (
  id TEXT PRIMARY KEY,
  owner_id TEXT,
  api_key_id TEXT,
  anonymous_session_id TEXT,
  metric TEXT NOT NULL,
  value INTEGER NOT NULL,
  period_start TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  severity TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS blocked_sources (
  id TEXT PRIMARY KEY,
  hostname TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_records (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  job_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (scope, idempotency_key),
  FOREIGN KEY (job_id) REFERENCES conversion_jobs(id) ON DELETE CASCADE
);
