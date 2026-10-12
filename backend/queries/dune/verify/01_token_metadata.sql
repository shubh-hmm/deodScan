-- Verify: Dune's token registry agrees with on-chain DEOD metadata.
SELECT blockchain, contract_address, symbol, decimals
FROM tokens.erc20
WHERE blockchain = 'bnb'
  AND contract_address = {{token_address}}
