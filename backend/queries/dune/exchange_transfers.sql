-- DEOD transfers on BNB Chain where sender OR receiver is a monitored exchange address.
-- One scan for all exchanges; IN/OUT per exchange is derived in Postgres from exchange_addresses.
-- Only the columns the app stores are selected (Dune bills result export per MB).
-- amount_raw is cast to VARCHAR so uint256 values survive JSON without float rounding.
-- Params: {{token_address}}, {{exchange_addresses}} (comma list), {{start_time}}, {{end_time}} (UTC, half-open)
SELECT
  t.block_time,
  t.block_number,
  t.tx_hash,
  t.evt_index,
  t."from"                       AS from_address,
  t."to"                         AS to_address,
  CAST(t.amount_raw AS VARCHAR)  AS amount_raw,
  t.tx_from
FROM tokens.transfers t
WHERE t.blockchain = 'bnb'
  AND t.contract_address = {{token_address}}
  AND (t."to" IN ({{exchange_addresses}}) OR t."from" IN ({{exchange_addresses}}))
  AND t.block_date >= CAST(TIMESTAMP '{{start_time}}' AS DATE)
  AND t.block_date <= CAST(TIMESTAMP '{{end_time}}' AS DATE)
  AND t.block_time >= TIMESTAMP '{{start_time}}'
  AND t.block_time <  TIMESTAMP '{{end_time}}'
ORDER BY t.block_number, t.evt_index
