-- Verify: which project/version/pool Dune attributes DEOD swaps to (should include both configured pools).
SELECT
  project, version, project_contract_address,
  COUNT(*)        AS trades,
  MIN(block_time) AS first_trade,
  MAX(block_time) AS last_trade
FROM dex.trades
WHERE blockchain = 'bnb'
  AND (token_bought_address = {{token_address}} OR token_sold_address = {{token_address}})
GROUP BY 1, 2, 3
ORDER BY trades DESC
