ALTER TABLE queue_message_deliveries ADD COLUMN status TEXT NOT NULL DEFAULT 'completed';
ALTER TABLE queue_message_deliveries ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE queue_message_deliveries ADD COLUMN lease_owner TEXT;
ALTER TABLE queue_message_deliveries ADD COLUMN lease_expires_at TEXT;
ALTER TABLE queue_message_deliveries ADD COLUMN last_error TEXT;
ALTER TABLE queue_message_deliveries ADD COLUMN completed_at TEXT;
ALTER TABLE queue_message_deliveries ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
ALTER TABLE queue_message_deliveries ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';

UPDATE queue_message_deliveries
SET completed_at = processed_at,
    created_at = processed_at,
    updated_at = processed_at
WHERE completed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_queue_message_deliveries_status
  ON queue_message_deliveries(status, lease_expires_at);

ALTER TABLE scheduled_tasks ADD COLUMN lease_owner TEXT;
ALTER TABLE scheduled_tasks ADD COLUMN lease_expires_at TEXT;
ALTER TABLE scheduled_tasks ADD COLUMN completed_at TEXT;

CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_lease
  ON scheduled_tasks(status, lease_expires_at);

ALTER TABLE client_webhook_events ADD COLUMN lease_owner TEXT;
ALTER TABLE client_webhook_events ADD COLUMN lease_expires_at TEXT;

CREATE INDEX IF NOT EXISTS idx_client_webhook_events_lease
  ON client_webhook_events(status, lease_expires_at);
