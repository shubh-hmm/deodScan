-- Notifications for alerts (phase 2): which alert was sent where, and when a channel was first switched on.
-- Nothing in this migration touches existing tables.

-- One row per alert and channel. status 'sent' = delivered; 'failed' = the last attempt failed (it is retried until max attempts).
CREATE TABLE notification_log (
  id               bigserial PRIMARY KEY,
  alert_id         bigint NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  channel          text NOT NULL CHECK (channel IN ('telegram')),
  status           text NOT NULL CHECK (status IN ('sent', 'failed')),
  attempts         int NOT NULL DEFAULT 1,
  error            text,
  last_attempt_at  timestamptz NOT NULL DEFAULT now(),
  sent_at          timestamptz,
  UNIQUE (alert_id, channel)
);
CREATE INDEX notification_log_status_idx ON notification_log (channel, status);

-- The moment a channel was first used. Only alerts created after it are sent, so switching a channel on never floods it with old alerts.
CREATE TABLE notification_channels (
  channel     text PRIMARY KEY,
  enabled_at  timestamptz NOT NULL DEFAULT now()
);
