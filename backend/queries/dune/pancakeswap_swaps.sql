-- DEOD swaps in the configured PancakeSwap V2/V3 pools on BNB Chain, from Dune's curated dex.trades.
-- Side is derived from actual token flow decoded from the Swap event:
--   token_bought (what the pool paid out) = DEOD  -> BUY ; token_sold (what was paid in) = DEOD -> SELL.
--   Anything else is returned as UNMATCHED so the app records it as a rejection rather than dropping it.
-- taker = swap recipient per Dune (frequently a router/aggregator); tx_from = transaction signer. Both kept.
-- Columns are kept minimal: Dune bills result export per MB. The quote token is implied by the pool
-- (each pool has exactly one quote token, and side=BUY/SELL already requires it to be a configured quote).
-- Verified 2026-10-02 against eth_getTransactionReceipt Swap logs (amounts and direction match exactly).
-- Params: {{token_address}}, {{quote_addresses}}, {{pool_addresses}}, {{start_time}}, {{end_time}} (UTC, half-open)
SELECT
  d.block_time,
  d.block_number,
  d.tx_hash,
  d.evt_index,
  d.version,
  d.project_contract_address AS pool_address,
  CASE
    WHEN d.token_bought_address = {{token_address}} AND d.token_sold_address IN ({{quote_addresses}}) THEN 'BUY'
    WHEN d.token_sold_address = {{token_address}} AND d.token_bought_address IN ({{quote_addresses}}) THEN 'SELL'
    ELSE 'UNMATCHED'
  END AS side,
  CAST(CASE WHEN d.token_bought_address = {{token_address}} THEN d.token_bought_amount_raw ELSE d.token_sold_amount_raw END AS VARCHAR) AS deod_amount_raw,
  CAST(CASE WHEN d.token_bought_address = {{token_address}} THEN d.token_sold_amount_raw ELSE d.token_bought_amount_raw END AS VARCHAR) AS quote_amount_raw,
  d.taker,
  d.tx_from
FROM dex.trades d
WHERE d.blockchain = 'bnb'
  AND d.project = 'pancakeswap'
  AND d.project_contract_address IN ({{pool_addresses}})
  AND d.block_date >= CAST(TIMESTAMP '{{start_time}}' AS DATE)
  AND d.block_date <= CAST(TIMESTAMP '{{end_time}}' AS DATE)
  AND d.block_time >= TIMESTAMP '{{start_time}}'
  AND d.block_time <  TIMESTAMP '{{end_time}}'
ORDER BY d.block_number, d.evt_index
