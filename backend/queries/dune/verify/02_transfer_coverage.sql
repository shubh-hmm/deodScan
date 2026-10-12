-- Verify: tokens.transfers has DEOD rows; show first/last indexed transfer and total counts.
SELECT
  COUNT(*)                         AS transfer_count,
  MIN(block_time)                  AS first_transfer,
  MAX(block_time)                  AS last_transfer,
  MAX(block_number)                AS last_block
FROM tokens.transfers
WHERE blockchain = 'bnb'
  AND contract_address = {{token_address}}
