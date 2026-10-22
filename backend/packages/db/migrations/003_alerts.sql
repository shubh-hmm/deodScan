-- Alerts and wallet monitoring (phase 1). Everything here is derived from rows already stored in exchange_flows and dex_swaps.
-- Nothing in this migration touches existing tables.

-- One row per rule kind. The thresholds live in config/alerts.yaml and are copied here on every scan so an alert can show its rule.
CREATE TABLE alert_rules (
  code        text PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('large_transfer', 'large_swap', 'flow_spike', 'watched_wallet')),
  name        text NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  severity    text NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high')),
  params      jsonb NOT NULL DEFAULT '{}',
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Wallets the owner chose to monitor. `watch` is from the wallet's point of view: incoming = the wallet received DEOD,
-- outgoing = the wallet sent DEOD. Only transfers that are recorded in the database can raise an alert.
CREATE TABLE watched_wallets (
  address     text PRIMARY KEY CHECK (address ~ '^0x[0-9a-f]{40}$'),
  label       text,
  watch       text NOT NULL DEFAULT 'both' CHECK (watch IN ('both', 'incoming', 'outgoing')),
  min_amount  numeric(78, 18) NOT NULL DEFAULT 0 CHECK (min_amount >= 0),
  enabled     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Stored alerts. dedup_key is unique, so scanning the same data again (a re-run sync, a rescan) can never create a second alert.
CREATE TABLE alerts (
  id            bigserial PRIMARY KEY,
  dedup_key     text NOT NULL UNIQUE,
  rule_code     text NOT NULL REFERENCES alert_rules(code),
  severity      text NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
  source        text NOT NULL CHECK (source IN ('exchange_flow', 'swap', 'daily_flow')),
  occurred_at   timestamptz NOT NULL,            -- block time of the transfer/swap, or the end of the UTC day for flow_spike
  exchange      text,                            -- exchange slug (exchange_flow / daily_flow)
  direction     text,                            -- IN / OUT (exchange point of view) or BUY / SELL
  amount        numeric(78, 18) NOT NULL,        -- DEOD
  usd_value     numeric(78, 18),
  sender        text,
  recipient     text,
  wallet_address text,                           -- the watched wallet, or the external counterparty
  tx_hash       text,
  evt_index     int,
  block_number  bigint,
  details       jsonb NOT NULL DEFAULT '{}',     -- rule-specific facts, e.g. baseline average and ratio for flow_spike
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX alerts_time_idx   ON alerts (occurred_at DESC, id DESC);
CREATE INDEX alerts_rule_idx   ON alerts (rule_code, occurred_at DESC);
CREATE INDEX alerts_wallet_idx ON alerts (wallet_address, occurred_at DESC);

-- How far the scanner has read: the highest exchange_flows / dex_swaps id already examined.
CREATE TABLE alert_state (
  name        text PRIMARY KEY,
  last_id     bigint NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
