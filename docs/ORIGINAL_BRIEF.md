# Original project brief

Supplied by the project owner on 2026-10-02 (re-shared 2026-10-03). This is the source specification.
Where the built system differs, the reason is recorded in [HANDOFF.md](../HANDOFF.md) §3.

---

# Build a DEOD On-Chain Exchange Flow Monitoring Platform Using Dune

I want you to build a production-ready **DEOD On-Chain Exchange Flow Monitor**.

The platform is READ-ONLY. It does not execute trades, send transactions, connect user wallets for signing, or perform any trading operation.

The primary purpose is:

> Track DEOD movement between external blockchain wallets, centralized exchanges, and PancakeSwap on BNB Chain.

I do NOT need internal centralized-exchange trading records.

I specifically want to know:

* Which blockchain addresses send DEOD into MEXC
* Which blockchain addresses receive DEOD from MEXC
* Which blockchain addresses send DEOD into BitMart
* Which blockchain addresses receive DEOD from BitMart
* Which blockchain addresses send DEOD into Toobit
* Which blockchain addresses receive DEOD from Toobit
* Which wallets trade DEOD through PancakeSwap V2
* Which wallets trade DEOD through PancakeSwap V3
* DEOD transfer volume
* Number of transactions
* First activity
* Last activity
* Buy/sell activity on PancakeSwap
* Exchange inflow/outflow volume
* Top wallets
* Wallet activity history
* Exchange comparison
* Time-based analytics

The blockchain is BNB Chain.

---

# 1. IMPORTANT DATA-SOURCE DECISION

Use **Dune as the primary blockchain/on-chain data source**.

Do NOT build a custom BNB RPC indexer for the initial version.

Do NOT use MEXC/BitMart/Toobit trading APIs because I do not need their internal order books or internal trade records.

The architecture should therefore be:

```text
                    BNB CHAIN
                       |
                      Dune
                       |
          +------------+-------------+
          |            |             |
        MEXC        BitMart        Toobit
        flows         flows         flows
          |            |             |
          +------------+-------------+
                       |
                PancakeSwap V2/V3
                       |
                       v
                  Dune API
                       |
                       v
                 Worker / ETL
                       |
                       v
                  PostgreSQL
                       |
                       v
                 Backend API
                       |
                       v
                  Web Dashboard
```

Dune should be responsible for querying blockchain data.

The application should periodically fetch Dune query results through the Dune API and store normalized results in PostgreSQL.

Do NOT query Dune directly from the browser for every dashboard request.

Use:

```text
Dune
  ↓
Worker
  ↓
PostgreSQL
  ↓
Backend
  ↓
Frontend
```

---

# 2. DUNE API KEY

The Dune API key exists in the project's environment as:

```env
DUNE_API_KEY=YOUR_DUNE_API_KEY
```

NEVER hardcode the API key in source code.

NEVER commit it to Git.

Create:

```text
.env
.env.example
```

`.env.example` should contain:

```env
DUNE_API_KEY=
DATABASE_URL=
```

The real key should only exist in `.env` or another secure secret store.

---

# 3. DEOD / BNB CHAIN CONFIGURATION

Create a centralized configuration file.

Do NOT scatter addresses throughout the codebase.

Use something like:

```yaml
chain:
  name: BNB Chain
  slug: bnb

token:
  symbol: DEOD
  chain: bnb
  address: TODO
  decimals: TODO

exchanges:
  mexc:
    address: "0x4982085C9e2F89F2eCb8131Eca71aFAD896e89CB"

  bitmart:
    address: "0xa23EF2319bA4C933eBfDbA80c332664A6Cb13F1A"

  toobit:
    address: "0xb0b1177e8B32BfB9744C50F1350C6a614cc1Aa77"

pancakeswap:
  v2:
    address: "0x185d73ec966d464a40372cd7e737bb68b0b95f1f"

  v3:
    address: "0xd693c42610bd30e63b0a68a25918445a5f9a1d20"
```

IMPORTANT:

Before implementing queries, verify exactly what each provided address represents.

For example, determine whether the MEXC/BitMart/Toobit addresses are:

* exchange hot wallets
* deposit wallets
* routing wallets
* treasury wallets
* aggregator wallets
* or another exchange-controlled address

Do not assume that one address represents every wallet owned by an exchange.

Also verify whether the PancakeSwap addresses are the actual DEOD pools and identify their token pair/token0/token1 and V2/V3 configuration.

If the DEOD token contract address and decimals are not provided, make them configuration values and clearly mark them as required input rather than inventing them.

---

# 4. CORE REQUIREMENT — EXCHANGE INFLOW

For each centralized exchange, identify DEOD transfers INTO the configured exchange-controlled address.

Example:

```text
User wallet
0xAAA...
     |
     | 500,000 DEOD
     v
MEXC address
0x498208...
```

Store this as:

```text
exchange = MEXC
direction = IN
from_address = 0xAAA...
to_address = 0x498208...
token = DEOD
amount = 500000
transaction_hash = ...
block_number = ...
block_time = ...
```

The dashboard should show:

```text
MEXC INFLOW

Wallet              Amount        Time
0xAAA...             500,000      10:21
0xBBB...             250,000      11:43
0xCCC...           1,200,000      14:10
```

---

# 5. CORE REQUIREMENT — EXCHANGE OUTFLOW

For each centralized exchange, identify DEOD transfers OUT of the configured exchange-controlled address.

Example:

```text
MEXC address
0x498208...
     |
     | 200,000 DEOD
     v
User wallet
0xDDD...
```

Store:

```text
exchange = MEXC
direction = OUT
from_address = 0x498208...
to_address = 0xDDD...
token = DEOD
amount = 200000
transaction_hash = ...
block_number = ...
block_time = ...
```

Do the same for:

* MEXC
* BitMart
* Toobit

---

# 6. VERY IMPORTANT — DO NOT CALL INTERNAL CEX TRADES

Do NOT attempt to determine:

```text
MEXC user placed buy order
MEXC user placed sell order
MEXC user bought 500,000 DEOD internally
```

We don't have that requirement.

The only thing we care about is:

```text
Blockchain wallet
      ↓
Exchange-controlled address
```

and:

```text
Exchange-controlled address
      ↓
Blockchain wallet
```

Therefore:

```text
IN  = DEOD enters exchange-controlled address

OUT = DEOD leaves exchange-controlled address
```

This is blockchain flow analysis.

---

# 7. PANCAKESWAP V2

Monitor the provided PancakeSwap V2 address:

```text
0x185d73ec966d464a40372cd7e737bb68b0b95f1f
```

First verify that it is the correct DEOD PancakeSwap V2 pool.

Identify:

* token0
* token1
* DEOD side
* quote token
* pool reserves where available
* swap events
* LP activity if relevant

Extract swaps involving DEOD.

For every swap, identify:

```text
transaction hash
block number
timestamp
trader / sender where supported
pool address
DEOD amount
quote amount
direction
price
USD value where reliably available
```

Determine buy/sell direction based on the actual token flow.

Do NOT simply assume the transaction sender is always the economically relevant trader without checking the swap/event structure.

---

# 8. PANCAKESWAP V3

Monitor:

```text
0xd693c42610bd30e63b0a68a25918445a5f9a1d20
```

First verify that this is the intended DEOD PancakeSwap V3 pool.

Identify:

* DEOD token
* quote token
* fee tier
* pool
* swaps
* liquidity
* price
* volume

Extract DEOD swaps and normalize them into the same internal trade format used for PancakeSwap V2.

The dashboard should allow:

```text
PancakeSwap
  ├── V2
  ├── V3
  └── Combined
```

---

# 9. WALLET IDENTIFICATION

The platform should maintain a wallet-centric view.

For example:

```text
Wallet:
0xAAA...
```

Activity:

```text
10:21
500,000 DEOD
→ MEXC

12:45
100,000 DEOD
→ PancakeSwap

15:20
250,000 DEOD
← MEXC
```

Create a wallet profile containing:

* address
* total DEOD inflow
* total DEOD outflow
* MEXC inflow
* MEXC outflow
* BitMart inflow
* BitMart outflow
* Toobit inflow
* Toobit outflow
* PancakeSwap buy volume
* PancakeSwap sell volume
* total transactions
* first activity
* last activity
* largest transfer
* largest swap
* recent activity

---

# 10. EXCHANGE FLOW ANALYTICS

For every exchange calculate:

### MEXC

```text
Total DEOD In
Total DEOD Out
Net Flow
Number of Deposits
Number of Withdrawals
Unique Deposit Addresses
Unique Withdrawal Addresses
Largest Deposit
Largest Withdrawal
```

Same for:

```text
BitMart
Toobit
```

Net flow:

```text
Net Flow = Inflow - Outflow
```

Do not interpret positive/negative net flow as automatically bullish/bearish.

Simply display the factual flow.

---

# 11. TIME FILTERS

Dashboard must support:

```text
Last 1 hour
Last 6 hours
Last 24 hours
Last 7 days
Last 30 days
Custom range
```

Analytics should include:

```text
Hourly inflow
Hourly outflow
Daily inflow
Daily outflow
Daily net flow
```

Example:

```text
Date        MEXC In       MEXC Out       Net
Oct 1       2.5M          1.2M          +1.3M
Oct 2       1.8M          2.1M          -0.3M
Oct 3       4.2M          1.0M          +3.2M
```

---

# 12. TOP WALLETS

Create:

### Top wallets by DEOD sent to MEXC

```text
Rank
Wallet
Total DEOD
Transactions
First seen
Last seen
```

### Top wallets by DEOD received from MEXC

Same structure.

Do the same for:

* BitMart
* Toobit
* PancakeSwap

Also provide:

```text
Top wallets overall
Top wallets by transaction count
Top wallets by total DEOD volume
Top wallets by largest single transfer
```

Do not call these people "traders" unless the data actually establishes trading activity.

Use neutral terms such as:

```text
Wallet
Address
Sender
Receiver
Trader
```

only where appropriate to the actual transaction type.

---

# 13. ADDRESS CLASSIFICATION

Create an address classification system.

Possible labels:

```text
MEXC
BitMart
Toobit
PancakeSwap V2
PancakeSwap V3
External Wallet
Unknown
```

An address should only receive an exchange label when there is sufficient evidence.

Do not assume that an address is an exchange wallet merely because it interacted with another known exchange address.

---

# 14. DATABASE DESIGN

Use PostgreSQL.

Create tables approximately like:

```text
exchange_addresses
------------------
id
exchange
address
chain
label
address_type
verified
created_at
updated_at
```

```text
token_transfers
---------------
id
chain
token_address
tx_hash
block_number
block_time
from_address
to_address
amount
amount_raw
```

```text
exchange_flows
--------------
id
exchange
direction
token_address
wallet_address
exchange_address
amount
tx_hash
block_number
block_time
```

```text
dex_swaps
---------
id
dex
version
pool_address
tx_hash
block_number
block_time
trader_address
token_in
amount_in
token_out
amount_out
deod_amount
quote_amount
side
price
```

```text
wallets
-------
address
first_seen
last_seen
total_in
total_out
transaction_count
```

Add appropriate indexes.

Do not use JavaScript floating-point numbers for token amounts.

Use:

* PostgreSQL NUMERIC
* bigint/raw integer representation
* decimal.js or equivalent when calculations are needed

---

# 15. DUNE QUERY STRATEGY

Do NOT create one giant Dune query for everything.

Create separate logical queries.

For example:

```text
Query 1
DEOD transfers involving MEXC

Query 2
DEOD transfers involving BitMart

Query 3
DEOD transfers involving Toobit

Query 4
PancakeSwap V2 DEOD swaps

Query 5
PancakeSwap V3 DEOD swaps

Query 6
Exchange flow daily aggregates

Query 7
Top DEOD wallets
```

If possible, use reusable parameters such as:

```text
DEOD token address
exchange address
start time
end time
```

Do not hardcode the token address into every query.

---

# 16. DUNE API WORKER

Build a worker that:

1. Executes the required Dune query.
2. Waits for completion when necessary.
3. Retrieves the result.
4. Validates the returned schema.
5. Normalizes the data.
6. Upserts into PostgreSQL.
7. Records the last successful execution.
8. Handles API errors.
9. Handles rate limits.
10. Logs failures.

Create a checkpoint system.

For example:

```text
dune_sync_state
---------------
query_name
last_successful_execution
last_block_time
last_sync_at
status
error
```

The system should avoid repeatedly importing the same transactions.

Use:

```text
tx_hash + log_index
```

or another correct blockchain event identifier as the unique key where applicable.

---

# 17. HISTORICAL BACKFILL

The system must support an initial historical backfill.

Example:

```text
Start date:
2026-01-01

End:
current time
```

Then after the initial backfill:

```text
Incremental sync
```

should only retrieve newer data.

Do not fetch the entire blockchain repeatedly.

---

# 18. REORGANIZATION / DATA QUALITY

Although Dune handles blockchain indexing, the application should still protect against duplicate records.

Use transaction/event identifiers.

Validate:

```text
duplicate transaction
duplicate event
invalid token address
unexpected exchange address
negative amount
invalid timestamp
```

Do not silently discard malformed data.

Log it.

---

# 19. DASHBOARD

Build a clean professional dashboard.

Main page:

```text
DEOD ON-CHAIN MONITOR
```

Cards:

```text
Total DEOD Exchange Inflow
Total DEOD Exchange Outflow
Net Exchange Flow
Unique Wallets
Total Transfers
PancakeSwap Volume
```

Then:

```text
Exchange Flow

        IN          OUT
MEXC    4.2M        2.1M
BitMart 1.5M        0.8M
Toobit  0.9M        1.2M
```

Then:

```text
Exchange Flow Chart

Time
  |
  |   IN
  |  /  \
  | /    \
  |       \

  |   OUT
  +----------------
```

Then:

```text
Recent Exchange Activity
```

Example:

```text
Time     Exchange   Wallet      Direction   Amount
14:21    MEXC       0xAAA...    IN          500K
14:25    MEXC       0xBBB...    OUT         200K
14:31    BitMart    0xCCC...    IN          1.2M
```

---

# 20. EXCHANGE PAGE

Create:

```text
/MEXC
/BitMart
/Toobit
```

Each page should show:

```text
Exchange
│
├── Inflow
├── Outflow
├── Net Flow
├── Unique Wallets
├── Largest Transfer
├── Recent Transfers
├── Top Deposit Wallets
├── Top Withdrawal Wallets
└── Historical Flow
```

---

# 21. PANCAKESWAP PAGE

Create:

```text
/PancakeSwap
```

Sections:

```text
V2
V3
Combined
```

Show:

```text
DEOD volume
Buy volume
Sell volume
Number of swaps
Unique wallets
Largest swap
Top wallets
Recent swaps
Historical volume
```

---

# 22. WALLET PAGE

Create:

```text
/wallet/0x...
```

Show:

```text
Wallet Address

Exchange activity
-----------------
MEXC IN
MEXC OUT
BitMart IN
BitMart OUT
Toobit IN
Toobit OUT

PancakeSwap activity
--------------------
V2 swaps
V3 swaps

Overall
-------
First seen
Last seen
Total DEOD volume
Transaction count
Largest transaction
```

Include a chronological activity timeline.

---

# 23. FILTERS

Add:

```text
Exchange
Direction
Wallet
Date range
Minimum DEOD amount
Maximum DEOD amount
Transaction count
DEX
PancakeSwap version
```

Examples:

```text
Exchange = MEXC
Direction = IN
Minimum amount = 100,000 DEOD
```

or:

```text
Exchange = MEXC
Direction = OUT
Last 7 days
```

or:

```text
PancakeSwap V2
DEOD volume > 1M
```

---

# 24. CSV EXPORT

Allow the user to export:

```text
Exchange flows
Wallet activity
PancakeSwap swaps
Top wallets
```

as CSV.

The export should contain the raw transaction hash so every record can be independently verified on BNB Chain.

---

# 25. BLOCKCHAIN EXPLORER LINKS

Every transaction should have a BscScan link.

Example:

```text
Transaction
0x123...

[View on BscScan]
```

Do not fabricate transaction URLs.

Generate them from the actual transaction hash.

---

# 26. SECURITY

Implement:

* Dune API key only on backend
* `.env` excluded from Git
* no private keys
* no wallet signing
* no transaction execution
* input validation
* SQL parameterization
* API rate limiting
* authentication for admin/sync endpoints
* structured logging

The frontend must never receive the Dune API key.

---

# 27. PROJECT STRUCTURE

Use a clean architecture such as:

```text
deod-monitor/

apps/
  web/
    Next.js
    TypeScript
    Tailwind

  api/
    Fastify
    TypeScript

  worker/
    Dune synchronization
    aggregation
    scheduled jobs

packages/
  db/
  core/
  dune/
  analytics/
  config/

database/
  migrations/

queries/
  dune/
    mexc_inflow.sql
    mexc_outflow.sql
    bitmart_inflow.sql
    bitmart_outflow.sql
    toobit_inflow.sql
    toobit_outflow.sql
    pancakeswap_v2.sql
    pancakeswap_v3.sql

.env
.env.example
docker-compose.yml
README.md
```

---

# 28. TECHNOLOGY

Use:

```text
Frontend:
Next.js
TypeScript
Tailwind CSS
Recharts

Backend:
Node.js
TypeScript
Fastify

Worker:
Node.js
TypeScript

Database:
PostgreSQL

Data source:
Dune API

Optional:
Redis for caching/background jobs
```

Do not introduce unnecessary technologies.

Keep the first version simple and maintainable.

---

# 29. DEVELOPMENT APPROACH

Do not try to build the entire system at once.

Build in this order:

### Phase 1

Verify all supplied addresses.

Verify:

* MEXC address
* BitMart address
* Toobit address
* PancakeSwap V2
* PancakeSwap V3

Verify the DEOD token address and decimals before writing final production queries.

### Phase 2

Create the Dune queries.

First prove that we can retrieve:

```text
DEOD → MEXC
MEXC → DEOD
DEOD → BitMart
BitMart → DEOD
DEOD → Toobit
Toobit → DEOD
```

### Phase 3

Build Dune API integration.

### Phase 4

Store results in PostgreSQL.

### Phase 5

Build analytics.

### Phase 6

Build dashboard.

### Phase 7

Add historical backfill.

### Phase 8

Add incremental synchronization.

### Phase 9

Add exports and wallet pages.

---

# 30. VERY IMPORTANT — DO NOT INVENT DATA

If Dune does not provide a particular field, do not fabricate it.

If an exchange address cannot be verified as a complete exchange wallet set, clearly state:

```text
This is monitoring the configured exchange address only.
It does not necessarily represent all wallets controlled by the exchange.
```

If Dune's current schema differs from an assumed schema, inspect the actual available Dune schema and adapt the query.

Do not blindly assume table or column names.

Do not assume:

```text
one exchange = one wallet
```

unless verified.

---

# 31. FINAL OBJECTIVE

The final product should answer questions such as:

### "How much DEOD entered MEXC today?"

```text
MEXC IN
4,250,000 DEOD
```

### "Which wallets sent DEOD to MEXC?"

```text
0xAAA...   1,200,000
0xBBB...     800,000
0xCCC...     500,000
```

### "How much DEOD left MEXC?"

```text
MEXC OUT
2,100,000 DEOD
```

### "Which wallets received it?"

```text
0xDDD...   900,000
0xEEE...   500,000
0xFFF...   300,000
```

### "What happened on PancakeSwap?"

```text
V2:
Volume
Swaps
Unique wallets

V3:
Volume
Swaps
Unique wallets
```

### "What has wallet 0xAAA done?"

Show its complete DEOD on-chain activity involving:

```text
MEXC
BitMart
Toobit
PancakeSwap V2
PancakeSwap V3
```

with transaction hashes and timestamps.

---

## FIRST TASK FOR YOU

Before writing the full application:

1. Inspect the current project directory.
2. Inspect the available Dune API/documentation capabilities.
3. Verify the five supplied protocol/exchange addresses on BNB Chain.
4. Identify what each address actually represents.
5. Determine the exact DEOD token contract address and decimals required for the queries.
6. Determine the correct Dune tables/columns for:

   * ERC-20 transfers
   * PancakeSwap V2 swaps
   * PancakeSwap V3 swaps
7. Create the first Dune SQL query for MEXC DEOD inflows/outflows.
8. Test the query.
9. Show me the actual returned data/schema.
10. Only after the data is verified, start implementing the application.

Do not proceed by guessing Dune table names, columns, token addresses, or protocol addresses.
