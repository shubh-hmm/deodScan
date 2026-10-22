-- !! EXPENSIVE: run once on 2026-10-22 over 2025-01-01 -> 2026-07-01 it was still executing after 6 minutes and had cost 71.16 credits when it
-- !! was cancelled (no result). Do not run it again over a range this wide. Use a short range, or ask for a different approach first.
-- Proof of the balance differences for exchanges whose history was loaded only from 2026-07-01 (XT, BingX, Poloniex, WEEX):
-- the net DEOD flow of each address BEFORE the load start. If IN - OUT here equals the difference between the live on-chain balance
-- and the stored balance, the difference is simply what the wallet already held. An aggregate, a handful of rows.
-- Params: {{token_address}}, {{exchange_addresses}}, {{start_time}}, {{end_time}} (UTC, half-open). Same shape as 08.
SELECT 'IN' AS direction, CAST(t."to" AS VARCHAR) AS address, COUNT(*) AS n, CAST(MIN(t.block_time) AS VARCHAR) AS first_time, CAST(SUM(t.amount_raw) AS VARCHAR) AS raw_sum
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
SELECT 'OUT' AS direction, CAST(t."from" AS VARCHAR) AS address, COUNT(*) AS n, CAST(MIN(t.block_time) AS VARCHAR) AS first_time, CAST(SUM(t.amount_raw) AS VARCHAR) AS raw_sum
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
