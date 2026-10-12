-- Sizing check before the swap backfill: DEOD swap counts per month and pool version in the configured
-- PancakeSwap pools. Same filters as pancakeswap_swaps.sql, but returns ~20 aggregate rows instead of every swap,
-- so the export cost is negligible. Rows x ~260 bytes gives the backfill's export size.
-- Params: {{pool_addresses}}, {{start_time}}, {{end_time}} (UTC, half-open)
SELECT
  date_trunc('month', d.block_time) AS month,
  d.version,
  count(*)                          AS swaps,
  min(d.block_time)                 AS first_swap,
  max(d.block_time)                 AS last_swap
FROM dex.trades d
WHERE d.blockchain = 'bnb'
  AND d.project = 'pancakeswap'
  AND d.project_contract_address IN ({{pool_addresses}})
  AND d.block_date >= CAST(TIMESTAMP '{{start_time}}' AS DATE)
  AND d.block_date <= CAST(TIMESTAMP '{{end_time}}' AS DATE)
  AND d.block_time >= TIMESTAMP '{{start_time}}'
  AND d.block_time <  TIMESTAMP '{{end_time}}'
GROUP BY 1, 2
ORDER BY 1, 2
