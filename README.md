# DEODScan

DEODScan is a read-only DEOD on-chain monitor.

A read-only dashboard that tracks DEOD token movement on **BNB Chain**:

- DEOD sent into, and withdrawn from, the monitored **MEXC** and **Toobit** addresses
- DEOD buys and sells in the **PancakeSwap V2 and V3** DEOD/USDT pools

The app never signs, sends or trades anything. Dune is the only source of on-chain data; the app holds no private keys and does not use any exchange API. The one other data source is the live DEOD market price in the dashboard header, from the free CoinGecko API (no key). It is shown as a market price, kept separate from the on-chain data, and is never stored.

```
Dune (BNB Chain) ──► worker (sync from Dune, check rows, write to DB) ──► PostgreSQL ──► API (Fastify) ──► Web (Next.js)
```

Only the backend talks to Dune. The browser talks only to the web app, and the web app calls the API from the server.

## Verified configuration

All addresses live in [`config/deod.yaml`](config/deod.yaml). Each entry records how it was checked.

| Item | Address | Evidence |
|---|---|---|
| DEOD token | `0x3510fbbc13090f991ffa523527113a166161683e` | `symbol()`=Deod, `decimals()`=18; Dune `tokens.erc20` agrees |
| PancakeSwap **V2** DEOD/USDT | `0xd693c42610bd30e63b0a68a25918445a5f9a1d20` | `factory()` = V2 factory; `getPair(DEOD,USDT)` returns this address |
| PancakeSwap **V3** DEOD/USDT 1% | `0x185d73ec966d464a40372cd7e737bb68b0b95f1f` | `factory()` = V3 factory; `getPool(DEOD,USDT,10000)` returns this address |
| MEXC | `0x4982085c9e2f89f2ecb8131eca71afad896e89cb` | Dune label "MEXC 4" |
| Toobit | `0xb0b1177e8b32bfb9744c50f1350c6a614cc1aa77` | Dune label "Cobo 4" (Cobo is a custody provider). Counted as Toobit by owner decision. |

- **The V2 and V3 labels in the original brief were swapped.** The table above shows the corrected labels.
- **Other exchange addresses were checked and left out.** We looked at every address Dune labels on BNB Chain for MEXC, BitMart and Cobo. Apart from the two above, each one only ever received 5–15 DEOD in total and never sent any. They're listed in the config but not monitored.
- **BitMart was removed on 2026-10-05** (owner decision; its address had no DEOD activity after 2026-08-19). Its stored history is archived in `archive/bitmart-removed-2026-10-05.csv`. `node scripts/remove-exchange.mjs <slug>` removes an exchange the same way: it archives first and refuses if any transfer is shared with another exchange.
- **The flow data is complete.** For every monitored address, IN minus OUT matched its on-chain DEOD balance exactly (checked 2026-10-02), so the stored history has no gaps.

**Coverage:** this monitors the configured addresses only. It does not necessarily include every wallet each exchange controls.

## Data rules

- **IN / OUT.** IN means DEOD arrives at a monitored exchange address; OUT means DEOD leaves it.
  - A transfer between two monitored exchanges counts once for each side: OUT for the sender, IN for the receiver.
  - A transfer from an address to itself is ignored.
- **Buy or sell.** This comes from the actual token movement in each PancakeSwap Swap event: DEOD paid out by the pool is a BUY, and DEOD paid into the pool is a SELL. Rows whose tokens don't match the pool are rejected and logged in `ingest_rejections`.
- **Who the trader is.** The trader is the wallet that **signed the transaction** (`tx_from`).
  - Dune's `taker` field is stored as the "recipient". In about 74% of swaps it's a router contract, not a person.
  - Swap amounts and directions were checked against raw on-chain receipts.
- **Amounts are exact.**
  - Token amounts are stored as `NUMERIC` (raw integer plus a decimal value).
  - Dune is asked for raw amounts as text, because its `amount` column is a floating-point number.
  - Decimal values are passed through the API as strings.
- **USD values** are calculated as USDT = $1. Each value records that basis in `usd_basis`.
- **No duplicates.** Each blockchain event is stored once, keyed by `(chain, tx_hash, evt_index)`; re-fetched rows are skipped. Every table rejects data from any chain other than `bnb`.
- **Labels.** Only configured exchange addresses and pools get labels. No behavioural labels (such as "whale" or "bot") are ever assigned.

## Running locally

```bash
npm install
cp .env.example .env               # set DUNE_API_KEY, DATABASE_URL, ADMIN_TOKEN

npm run db:dev                     # local Postgres on :5433 (or: docker compose up -d postgres)
npm run db:migrate                 # create the schema and load addresses/pools from config/deod.yaml

# One-off history load (resumes from where it stopped if interrupted)
npm run sync -- backfill --query exchange_transfers --from 2026-01-01 --window-days 92
npm run sync -- backfill --query pancakeswap_swaps  --from 2026-01-01 --window-days 30

npm run worker                     # daily sync: fetches each completed UTC day once (see "Daily sync")
npm run sync -- daily              # same, run once by hand
npm run api                        # API on :4000
npm run web                        # dashboard on :3000
```

`npm test` runs the unit tests and `npm run typecheck` runs the type checker.

## Dune queries and cost

The SQL lives in [`queries/dune/`](queries/dune/) and runs through `POST /v1/sql/execute`, which needs only a Read-scope API key. The `verify/` subfolder holds the one-off checks used to confirm the setup.

| Query | Source table | Purpose |
|---|---|---|
| `exchange_transfers.sql` | `tokens.transfers` | DEOD transfers involving any monitored exchange address, in one scan. The app works out IN/OUT per exchange in Postgres. |
| `pancakeswap_swaps.sql` | `dex.trades` | DEOD swaps in the configured pools, with buy/sell worked out in SQL |

Credit costs measured on the Analyst plan (export costs 10 credits per MB):

| Operation | Cost |
|---|---|
| Full exchange-transfer history (5,681 rows) | about 22 credits |
| Swap rows | about 260 bytes each: roughly 2.6 credits per 1,000 rows, plus execution |
| One daily sync (both queries, one day) | about 0.2–1 credit plus export (a busy day of ~700 swaps adds about 2 credits) |

### Daily sync

Data is synced once per **completed UTC day**. The current, incomplete day is never fetched.

- A day [00:00, 24:00) UTC is fetched in one window, `SYNC_SETTLE_HOURS` (default 2) after it ends, so Dune has indexed its last blocks.
- The worker checks every `SYNC_INTERVAL_MINUTES` (default 60). A check with no new completed day makes no Dune call.
- Missed days (for example, the worker was off) are caught up one day per window. The checkpoint (`synced_until`) moves after each day, so an interruption resumes at the first unsynced day.
- The dashboard shows "Data through …": activity after that point appears once its day is complete. The 1h / 6h / 24h ranges count back from the current time, so they show little or nothing until the day is synced.
- Swap history starts on 2026-09-25 (the owner decided on 2026-10-03 against a full historical swap backfill). Exchange transfers go back to 2026-01-01.

Avoid joining `tokens.transfers` to label tables: one exploratory query that did this cost 293 credits.

## API

These read endpoints take `range=1h|6h|24h|7d|30d|all|custom` (with `from` and `to` for custom). The ones marked CSV also accept `format=csv`; exports include the raw transaction hash and a BscScan link.

| Endpoint | Returns |
|---|---|
| `/api/price` | Live DEOD/USD price, 24h change, volume and market cap from CoinGecko. Cached for 60 s; if CoinGecko is down it serves the last good value (`stale: true`) for up to 10 min, then returns 503. |
| `/api/overview` | Dashboard summary |
| `/api/flows` | Exchange flows. Filters: `exchange`, `direction`, `wallet`, `min`, `max`, `sort`. CSV. |
| `/api/flows/series` | Flow totals per hour or day |
| `/api/flows/hourly` | Exchange transfer counts (IN / OUT) by UTC hour of day, 0–23 |
| `/api/exchanges/:slug` | One exchange's stats, top wallets and history |
| `/api/pancakeswap` | Pool stats. `version=2\|3\|all` |
| `/api/swaps` | Swap list. Filters: `version`, `side`, `wallet`, `min`, `max`. CSV. |
| `/api/wallets/top` | Ranked wallets. Params: `source`, `sort`, `minVolume`, `minTx`, `limit`. CSV. |
| `/api/wallets/:address` | Wallet profile and timeline |
| `/api/wallets/:address/activity.csv` | Wallet activity as CSV |
| `/api/search` | Look up a wallet address or transaction hash |
| `/api/sync/status` | Sync checkpoints and recent runs |

Admin endpoints need `Authorization: Bearer $ADMIN_TOKEN`:

| Endpoint | Action |
|---|---|
| `POST /api/admin/sync` | Run the daily sync now (fetches any completed day not yet synced) |
| `POST /api/admin/exchange-addresses` | Add an exchange address |
| `PATCH /api/admin/exchange-addresses/:address` | Set `verified` or `monitored` |

Only one sync can run at a time across the worker, CLI and API.
