-- Discovery: which Dune-labelled exchange addresses ON BNB CHAIN have any DEOD activity ON BNB CHAIN.
-- Step 1 restricts labels to blockchain = 'bnb' before anything else; step 2 checks DEOD transfers on bnb only.
WITH labelled AS (
  SELECT DISTINCT address, cex_name, distinct_name
  FROM cex.addresses
  WHERE blockchain = 'bnb'
    AND lower(cex_name) IN ('mexc', 'bitmart', 'toobit', 'cobo')
),
deod AS (
  SELECT "from", "to", amount_raw, block_time
  FROM tokens.transfers
  WHERE blockchain = 'bnb'
    AND contract_address = {{token_address}}
    AND "from" <> "to"
),
legs AS (
  SELECT l.cex_name, l.distinct_name, l.address, 'IN' AS direction, d.amount_raw, d.block_time
  FROM deod d JOIN labelled l ON d."to" = l.address
  UNION ALL
  SELECT l.cex_name, l.distinct_name, l.address, 'OUT', d.amount_raw, d.block_time
  FROM deod d JOIN labelled l ON d."from" = l.address
)
SELECT
  'bnb'                                                            AS blockchain,
  cex_name, distinct_name, address,
  COUNT_IF(direction = 'IN')                                       AS in_count,
  COUNT_IF(direction = 'OUT')                                      AS out_count,
  CAST(SUM(CASE WHEN direction = 'IN'  THEN amount_raw ELSE UINT256 '0' END) AS VARCHAR) AS in_raw,
  CAST(SUM(CASE WHEN direction = 'OUT' THEN amount_raw ELSE UINT256 '0' END) AS VARCHAR) AS out_raw,
  MIN(block_time)                                                  AS first_activity,
  MAX(block_time)                                                  AS last_activity
FROM legs
GROUP BY 1, 2, 3, 4
ORDER BY cex_name, in_count + out_count DESC
