-- Audit cross-check: per monitored address and direction, the number of DEOD transfers and the EXACT sum of raw amounts
-- in a window, computed by Dune itself (an aggregate, independent of the row-by-row ingestion the app stores).
-- Self-transfers are excluded, as in the app. The result is a handful of rows, so the export cost is negligible.
-- Params: {{token_address}}, {{exchange_addresses}}, {{start_time}}, {{end_time}} (UTC, half-open)
SELECT 'IN' AS direction, CAST(t."to" AS VARCHAR) AS address, COUNT(*) AS n, CAST(SUM(t.amount_raw) AS VARCHAR) AS raw_sum
FROM tokens.transfers t
WHERE t.blockchain = 'bnb'
  AND t.contract_address = {{token_address}}
  AND t."to" IN ({{exchange_addresses}})
  AND t."from" <> t."to"
  AND t.block_date >= CAST(TIMESTAMP '{{start_time}}' AS DATE)
  AND t.block_date <= CAST(TIMESTAMP '{{end_time}}' AS DATE)
  AND t.block_time >= TIMESTAMP '{{start_time}}'
  AND t.block_time <  TIMESTAMP '{{end_time}}'
GROUP BY 1, 2
UNION ALL
SELECT 'OUT' AS direction, CAST(t."from" AS VARCHAR) AS address, COUNT(*) AS n, CAST(SUM(t.amount_raw) AS VARCHAR) AS raw_sum
FROM tokens.transfers t
WHERE t.blockchain = 'bnb'
  AND t.contract_address = {{token_address}}
  AND t."from" IN ({{exchange_addresses}})
  AND t."from" <> t."to"
  AND t.block_date >= CAST(TIMESTAMP '{{start_time}}' AS DATE)
  AND t.block_date <= CAST(TIMESTAMP '{{end_time}}' AS DATE)
  AND t.block_time >= TIMESTAMP '{{start_time}}'
  AND t.block_time <  TIMESTAMP '{{end_time}}'
GROUP BY 1, 2
ORDER BY 1, 2
