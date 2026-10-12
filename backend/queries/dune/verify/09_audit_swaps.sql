-- Audit cross-check: per pool, the number of DEOD swaps, the number of buys (pool pays out DEOD) and the EXACT sum of raw
-- DEOD amounts in a window, computed by Dune as an aggregate (independent of the row-by-row ingestion the app stores).
-- Same filters as pancakeswap_swaps.sql. A handful of result rows, so the export cost is negligible.
-- Params: {{token_address}}, {{pool_addresses}}, {{start_time}}, {{end_time}} (UTC, half-open)
SELECT
  d.version,
  CAST(d.project_contract_address AS VARCHAR) AS pool,
  COUNT(*) AS n,
  COUNT_IF(d.token_bought_address = {{token_address}}) AS buys,
  CAST(SUM(CASE WHEN d.token_bought_address = {{token_address}} THEN d.token_bought_amount_raw ELSE d.token_sold_amount_raw END) AS VARCHAR) AS deod_raw_sum
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
