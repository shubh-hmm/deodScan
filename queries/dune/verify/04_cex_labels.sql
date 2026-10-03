-- Verify: does Dune's CEX label set know the configured exchange addresses?
-- If cex.addresses does not exist under this name, this query fails and we learn that instead of guessing.
SELECT blockchain, address, cex_name, distinct_name
FROM cex.addresses
WHERE blockchain = 'bnb'
  AND address IN ({{exchange_addresses}})
