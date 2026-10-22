-- Telegram bot with an access code (replaces the single fixed chat id of migration 004).
-- A person starts the bot, sends the access code to be allowed in, then is asked whether to receive alerts. Alerts go to everyone who said yes.

CREATE TABLE telegram_users (
  chat_id          bigint PRIMARY KEY,
  username         text,
  first_name       text,
  -- new = has not entered the code; authorized = code accepted, alerts not (or no longer) wanted; subscribed = receives alerts;
  -- blocked = turned away by the owner (revoked), the bot ignores this chat
  status           text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'authorized', 'subscribed', 'blocked')),
  failed_attempts  int NOT NULL DEFAULT 0,
  locked_until     timestamptz,                -- too many wrong codes: no more attempts until then
  authorized_at    timestamptz,
  subscribed_at    timestamptz,                -- only alerts created after this moment are sent to this person
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX telegram_users_status_idx ON telegram_users (status);

-- One delivery record per alert, channel and recipient (the Telegram chat id).
ALTER TABLE notification_log ADD COLUMN recipient text NOT NULL DEFAULT '';
ALTER TABLE notification_log DROP CONSTRAINT notification_log_alert_id_channel_key;
ALTER TABLE notification_log ADD CONSTRAINT notification_log_alert_channel_recipient_key UNIQUE (alert_id, channel, recipient);

-- Superseded by telegram_users.subscribed_at (each person has their own start moment).
DROP TABLE notification_channels;
