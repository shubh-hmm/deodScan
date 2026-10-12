-- Verify: every BNB address Dune labels for the monitored exchanges (and Cobo, which labels the supplied "Toobit" address).
-- Used to detect internal exchange-to-exchange movements that would otherwise be counted as external flows.
SELECT cex_name, distinct_name, address
FROM cex.addresses
WHERE blockchain = 'bnb'
  AND lower(cex_name) IN ('mexc', 'bitmart', 'toobit', 'cobo')
ORDER BY cex_name, distinct_name
