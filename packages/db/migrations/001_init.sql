-- DEOD On-Chain Monitor: initial schema. BNB Chain only (enforced by CHECK constraints).
-- Token amounts: *_raw = exact on-chain integer (NUMERIC(78,0) fits uint256); decimal columns are exact NUMERIC.

CREATE TABLE exchanges (
  slug        text PRIMARY KEY CHECK (slug ~ '^[a-z0-9_]+$'),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE exchange_addresses (
  id            bigserial PRIMARY KEY,
  exchange      text NOT NULL REFERENCES exchanges(slug),
  chain         text NOT NULL DEFAULT 'bnb' CHECK (chain = 'bnb'),
  address       text NOT NULL CHECK (address ~ '^0x[0-9a-f]{40}$'),
  label         text,
  address_type  text NOT NULL,
  source        text NOT NULL,            -- 'config' | 'admin'
  verified      boolean NOT NULL DEFAULT false,
  monitored     boolean NOT NULL DEFAULT true,
  dune_label    text,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain, address)
);

CREATE TABLE dex_pools (
  address          text PRIMARY KEY CHECK (address ~ '^0x[0-9a-f]{40}$'),
  chain            text NOT NULL DEFAULT 'bnb' CHECK (chain = 'bnb'),
  dex              text NOT NULL DEFAULT 'pancakeswap',
  version          text NOT NULL CHECK (version IN ('2', '3')),
  pair             text NOT NULL,
  deod_address     text NOT NULL,
  quote_address    text NOT NULL,
  quote_symbol     text NOT NULL,
  quote_decimals   int  NOT NULL,
  fee_tier         int,
  verification     text,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Raw DEOD transfers that touch at least one monitored exchange address (as returned by Dune).
CREATE TABLE token_transfers (
  id             bigserial PRIMARY KEY,
  chain          text NOT NULL DEFAULT 'bnb' CHECK (chain = 'bnb'),
  token_address  text NOT NULL,
  tx_hash        text NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  evt_index      int  NOT NULL CHECK (evt_index >= 0),
  block_number   bigint NOT NULL CHECK (block_number > 0),
  block_time     timestamptz NOT NULL,
  from_address   text NOT NULL,
  to_address     text NOT NULL,
  amount_raw     numeric(78, 0) NOT NULL CHECK (amount_raw >= 0),
  amount         numeric(78, 18) NOT NULL CHECK (amount >= 0),
  tx_from        text,
  source         text NOT NULL DEFAULT 'dune:tokens.transfers',
  ingested_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain, tx_hash, evt_index)
);
CREATE INDEX token_transfers_time_idx ON token_transfers (block_time);
CREATE INDEX token_transfers_from_idx ON token_transfers (from_address);
CREATE INDEX token_transfers_to_idx   ON token_transfers (to_address);

-- One row per (monitored exchange address, transfer, direction). Derived from token_transfers.
CREATE TABLE exchange_flows (
  id                bigserial PRIMARY KEY,
  chain             text NOT NULL DEFAULT 'bnb' CHECK (chain = 'bnb'),
  exchange          text NOT NULL REFERENCES exchanges(slug),
  direction         text NOT NULL CHECK (direction IN ('IN', 'OUT')),
  token_address     text NOT NULL,
  wallet_address    text NOT NULL,      -- external counterparty
  exchange_address  text NOT NULL,      -- monitored exchange-controlled address
  amount_raw        numeric(78, 0) NOT NULL,
  amount            numeric(78, 18) NOT NULL,
  tx_hash           text NOT NULL,
  evt_index         int  NOT NULL,
  block_number      bigint NOT NULL,
  block_time        timestamptz NOT NULL,
  UNIQUE (exchange_address, tx_hash, evt_index, direction)
);
CREATE INDEX exchange_flows_ex_time_idx     ON exchange_flows (exchange, block_time);
CREATE INDEX exchange_flows_wallet_time_idx ON exchange_flows (wallet_address, block_time);
CREATE INDEX exchange_flows_time_idx        ON exchange_flows (block_time);
CREATE INDEX exchange_flows_amount_idx      ON exchange_flows (amount);

CREATE TABLE dex_swaps (
  id                 bigserial PRIMARY KEY,
  chain              text NOT NULL DEFAULT 'bnb' CHECK (chain = 'bnb'),
  dex                text NOT NULL DEFAULT 'pancakeswap',
  version            text NOT NULL CHECK (version IN ('2', '3')),
  pool_address       text NOT NULL REFERENCES dex_pools(address),
  tx_hash            text NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  evt_index          int  NOT NULL CHECK (evt_index >= 0),
  block_number       bigint NOT NULL,
  block_time         timestamptz NOT NULL,
  trader_address     text NOT NULL,     -- transaction signer (tx_from)
  recipient_address  text,              -- Swap event recipient per Dune `taker`; often a router
  tx_to              text,              -- contract the transaction called (router/aggregator)
  side               text NOT NULL CHECK (side IN ('BUY', 'SELL')),
  token_in           text NOT NULL,
  amount_in_raw      numeric(78, 0) NOT NULL,
  token_out          text NOT NULL,
  amount_out_raw     numeric(78, 0) NOT NULL,
  deod_amount_raw    numeric(78, 0) NOT NULL CHECK (deod_amount_raw > 0),
  deod_amount        numeric(78, 18) NOT NULL,
  quote_token        text NOT NULL,
  quote_amount_raw   numeric(78, 0) NOT NULL,
  quote_amount       numeric(78, 18) NOT NULL,
  price              numeric(60, 30) NOT NULL,   -- quote per DEOD
  usd_value          numeric(78, 18),            -- only when the quote token is configured as a USD peg
  usd_basis          text,                       -- e.g. 'usdt_peg'
  source             text NOT NULL DEFAULT 'dune:dex.trades',
  ingested_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain, tx_hash, evt_index)
);
CREATE INDEX dex_swaps_time_idx         ON dex_swaps (block_time);
CREATE INDEX dex_swaps_version_time_idx ON dex_swaps (version, block_time);
CREATE INDEX dex_swaps_trader_time_idx  ON dex_swaps (trader_address, block_time);
CREATE INDEX dex_swaps_deod_amount_idx  ON dex_swaps (deod_amount);

-- Checkpoint per logical Dune query.
CREATE TABLE dune_sync_state (
  query_name                 text PRIMARY KEY,
  status                     text NOT NULL DEFAULT 'idle',   -- idle | running | ok | error
  last_successful_execution  text,
  last_block_time            timestamptz,   -- newest block_time ingested
  synced_until               timestamptz,   -- end of the last fully ingested window (exclusive)
  last_sync_at               timestamptz,
  credits_total              numeric NOT NULL DEFAULT 0,
  error                      text,
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

-- Audit trail of every Dune execution the worker made.
CREATE TABLE sync_runs (
  id              bigserial PRIMARY KEY,
  query_name      text NOT NULL,
  mode            text NOT NULL,            -- backfill | incremental
  execution_id    text,
  window_start    timestamptz NOT NULL,
  window_end      timestamptz NOT NULL,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  status          text NOT NULL DEFAULT 'running',
  rows_fetched    int,
  rows_inserted   int,
  rows_duplicate  int,
  rows_rejected   int,
  credits         numeric,
  error           text
);
CREATE INDEX sync_runs_query_idx ON sync_runs (query_name, started_at DESC);

-- Malformed rows are recorded here, never silently dropped.
CREATE TABLE ingest_rejections (
  id            bigserial PRIMARY KEY,
  query_name    text NOT NULL,
  execution_id  text,
  reasons       text[] NOT NULL,
  raw           jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Wallet-centric summary across monitored activity (exchange flows + PancakeSwap swaps).
CREATE MATERIALIZED VIEW wallet_summary AS
WITH activity AS (
  SELECT wallet_address AS address, block_time, tx_hash, amount AS deod_amount,
         CASE WHEN direction = 'IN' THEN amount END  AS sent_to_exchanges,
         CASE WHEN direction = 'OUT' THEN amount END AS received_from_exchanges,
         amount AS transfer_amount,
         NULL::numeric AS buy_deod, NULL::numeric AS sell_deod, NULL::numeric AS swap_deod, NULL::numeric AS swap_usd
  FROM exchange_flows
  UNION ALL
  SELECT trader_address, block_time, tx_hash, deod_amount,
         NULL, NULL, NULL,
         CASE WHEN side = 'BUY' THEN deod_amount END,
         CASE WHEN side = 'SELL' THEN deod_amount END,
         deod_amount, usd_value
  FROM dex_swaps
)
SELECT
  address,
  min(block_time)                          AS first_seen,
  max(block_time)                          AS last_seen,
  count(DISTINCT tx_hash)                  AS transaction_count,
  coalesce(sum(deod_amount), 0)            AS total_deod_volume,
  coalesce(sum(sent_to_exchanges), 0)      AS sent_to_exchanges,
  coalesce(sum(received_from_exchanges), 0) AS received_from_exchanges,
  count(transfer_amount)                   AS exchange_transfer_count,
  coalesce(sum(buy_deod), 0)               AS swap_buy_deod,
  coalesce(sum(sell_deod), 0)              AS swap_sell_deod,
  count(swap_deod)                         AS swap_count,
  coalesce(sum(swap_usd), 0)               AS swap_usd_volume,
  max(transfer_amount)                     AS largest_transfer,
  max(swap_deod)                           AS largest_swap
FROM activity
GROUP BY address;

CREATE UNIQUE INDEX wallet_summary_address_idx ON wallet_summary (address);
CREATE INDEX wallet_summary_volume_idx ON wallet_summary (total_deod_volume DESC);
CREATE INDEX wallet_summary_count_idx  ON wallet_summary (transaction_count DESC);
