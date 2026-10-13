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

## Project layout

The project is two independent parts that talk only over HTTP.

```
G:\Monitor
├── frontend/               The dashboard (Next.js). Its own package.json and node_modules.
│   ├── app/                Pages: dashboard, exchanges, PancakeSwap, flows, swaps, wallets, status
│   ├── components/         Charts, tables, navigation, price bar, greeting
│   └── lib/                API client, number formatting, colours
│
├── backend/                Everything that touches data. Its own package.json and node_modules.
│   ├── api/                Fastify HTTP API (port 4000): reads PostgreSQL, serves the dashboard and CSV exports
│   ├── worker/             Daily sync: Dune -> validate -> PostgreSQL
│   ├── packages/           Libraries shared by the API and the worker
│   │   ├── config/         Loads config/deod.yaml and .env
│   │   ├── core/           Pure logic: amount maths, validation, classification (unit-tested)
│   │   ├── db/             PostgreSQL access and migrations/
│   │   ├── dune/           Dune API client
│   │   └── analytics/      The SQL behind every dashboard number
│   ├── config/deod.yaml    All verified addresses (token, pools, exchanges)
│   ├── queries/dune/       The SQL sent to Dune (verify/ holds the one-off checks)
│   ├── scripts/            dev.ts (the one-command backend), audit, remove-exchange, dune-run, dev-postgres
│   ├── archive/            Data removed from the database, kept as CSV
│   ├── .env                Secrets (DUNE_API_KEY, DATABASE_URL, ADMIN_TOKEN); git-ignored
│   └── docker-compose.yml  PostgreSQL for a server deployment
│
├── docs/                   The original project brief
├── scripts/                start.ps1 and stop.ps1 (used by run.cmd and stop.cmd)
├── run.cmd  stop.cmd       Start and stop everything (Windows)
├── package.json            Only forwards commands to backend/ and frontend/ (no code, no dependencies)
├── README.md  HANDOFF.md  CLAUDE.md
```

**How the parts connect:** `worker` fetches from Dune and writes to PostgreSQL; `api` reads PostgreSQL and exposes `/api/*`; `frontend` calls the API from its server (never from the browser) and renders the pages. The frontend shares no code with the backend and imports none of it. Its one setting is `API_BASE_URL` (default `http://localhost:4000`, see `frontend/.env.example`).

**Commands** can be run from the project root (they forward to the right folder) or from inside `backend/` or `frontend/`:

| From the root | Does |
|---|---|
| `npm run install:all` | `npm install` in `backend/` and in `frontend/` |
| `npm run dev:backend` / `dev:worker` / `dev:frontend` | the two-terminal commands above, forwarded from the root (backend with or without the worker; the dashboard) |
| `npm run api` / `worker` / `web` | start the API / the sync worker / the dashboard on their own |
| `npm run db:dev` / `db:migrate` | start the local database / apply migrations |
| `npm run sync -- daily` | fetch any finished days once |
| `npm run typecheck` / `test` / `audit` | check types (both parts) / unit tests / data audit |

## Verified configuration

All addresses live in [`backend/config/deod.yaml`](backend/config/deod.yaml). Each entry records how it was checked.

| Item | Address | Evidence |
|---|---|---|
| DEOD token | `0x3510fbbc13090f991ffa523527113a166161683e` | `symbol()`=Deod, `decimals()`=18; Dune `tokens.erc20` agrees |
| PancakeSwap **V2** DEOD/USDT | `0xd693c42610bd30e63b0a68a25918445a5f9a1d20` | `factory()` = V2 factory; `getPair(DEOD,USDT)` returns this address |
| PancakeSwap **V3** DEOD/USDT 1% | `0x185d73ec966d464a40372cd7e737bb68b0b95f1f` | `factory()` = V3 factory; `getPool(DEOD,USDT,10000)` returns this address |
| MEXC | `0x4982085c9e2f89f2ecb8131eca71afad896e89cb` | Dune label "MEXC 4" |
| Toobit | `0xb0b1177e8b32bfb9744c50f1350c6a614cc1aa77` | Dune label "Cobo 4" (Cobo is a custody provider). Counted as Toobit by owner decision. |

- **The V2 and V3 labels in the original brief were swapped.** The table above shows the corrected labels.
- **Other exchange addresses were checked and left out.** We looked at every address Dune labels on BNB Chain for MEXC, BitMart and Cobo. Apart from the two above, each one only ever received 5–15 DEOD in total and never sent any. They're listed in the config but not monitored.
- **BitMart was removed on 2026-10-05** (owner decision; its address had no DEOD activity after 2026-08-19). Its stored history is archived in `backend/archive/bitmart-removed-2026-10-05.csv`. `node scripts/remove-exchange.mjs <slug>` removes an exchange the same way: it archives first and refuses if any transfer is shared with another exchange.
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

## Starting and stopping (Windows)

Run everything from the project folder `G:\Monitor` (the folder that contains `package.json`).

| What | How |
|---|---|
| **Start everything** | Double-click `run.cmd`, or open a terminal in `G:\Monitor` and type `.\run.cmd` (PowerShell) or `run.cmd` (Command Prompt). |
| **Stop everything** | Double-click `stop.cmd`, or type `.\stop.cmd`. Closing the three "DEODScan" windows also stops the services. |

`run.cmd` starts the database, then the API, the dashboard and the daily-sync worker (each in its own window so you can see its log), waits until they answer, and opens http://localhost:3000. It is safe to run twice; anything already running is left alone.

Options: `.\run.cmd -NoWorker` (do not start the worker, so no Dune credits are used), `.\run.cmd -NoBrowser`, `.\run.cmd -Hidden` (no visible windows).

After the PC has been off, the worker fetches any finished days it missed by itself, usually for well under 1 Dune credit per day. Nothing is synced while the PC is off, and nothing restarts on its own after a reboot.

The scripts behind them are `scripts/start.ps1` and `scripts/stop.ps1`. Run from the project root, `G:\Monitor`.

## Running by hand in VS Code (two terminals)

Open the folder `G:\Monitor` in VS Code and open two terminals (Terminal > New Terminal, then the **+** button).

| Terminal | Folder | Command | What it starts |
|---|---|---|---|
| **Backend** | `G:\Monitor\backend` | `npm run dev` | PostgreSQL, then the API on port 4000. **The Dune worker is off.** |
| **Frontend** | `G:\Monitor\frontend` | `npm run dev` | The dashboard at http://localhost:3000 |

Start the backend first. (If you start the dashboard first it still works; it just tells you the backend is not up yet.)

**The Dune worker is optional.** It is the only part that spends Dune credits (it fetches any finished days it missed; usually under 1 credit per day, occasionally about 8). It only starts if you ask for it: run `npm run dev:worker` in the backend terminal instead of `npm run dev`. (Also accepted: `DEV_WORKER=1`, or `npm run dev -- --worker`; in PowerShell prefer `dev:worker`, because PowerShell swallows the `--`.)

**To stop:** press `Ctrl+C` once in each terminal. The backend stops the worker first (a sync that is already running gets up to 20 seconds to finish, and no new day is started), then the API, then the database, cleanly. Wait for `Everything stopped cleanly`. A second `Ctrl+C` forces it. (In Command Prompt, as opposed to the PowerShell VS Code uses, Windows also asks "Terminate batch job (Y/N)?" after Ctrl+C; let the backend finish before you answer.)

**It protects you from duplicates:**

| Situation | What happens |
|---|---|
| `npm run dev` already running in `backend/` | The second one refuses and says which process is running. |
| The database or the API is already running (started another way) | It reuses it, and will never stop what it did not start. |
| A worker is already running | No second worker is started. |
| Dashboard port 3000 already in use | The frontend refuses and tells you how to stop the old one. |
| A previous run crashed and left its lock file | The stale lock is detected and replaced. |

Settings are unchanged: `backend/.env` for the backend, and `frontend/.env.local` (optional, see `frontend/.env.example`). The backend command is `backend/scripts/dev.ts`; the frontend command is `frontend/scripts/dev.mjs`.

The older commands all still work: `npm run db:dev`, `api`, `worker`, `web` (one part at a time, from the project root), and `run.cmd` / `stop.cmd` (everything in the background). `.\stop.cmd` also stops a stack started with `npm run dev`.

## Running locally

```bash
npm run install:all                 # installs backend/ and frontend/ (one time)
cp backend/.env.example backend/.env   # set DUNE_API_KEY, DATABASE_URL, ADMIN_TOKEN

npm run db:dev                     # local Postgres on :5433 (or: docker compose up -d postgres)
npm run db:migrate                 # create the schema and load addresses/pools from backend/config/deod.yaml

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

The SQL lives in [`backend/queries/dune/`](backend/queries/dune/) and runs through `POST /v1/sql/execute`, which needs only a Read-scope API key. The `verify/` subfolder holds the one-off checks used to confirm the setup.

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

## Time period is remembered

The period you pick (1H, 6H, 24H, 7D, 30D, All or a custom date range) stays selected on every page, in new tabs and after a reload. It is kept in a browser cookie named `deod_range` (one year). A period in the address always wins and becomes the new remembered one. To forget it, delete that cookie.

## Data audit

`npm run audit` cross-checks what the dashboard shows against independent sources. It is read-only and spends no Dune credits (`--no-chain` skips the blockchain sampling).

1. **Database rules:** no duplicates, exact amount maths, consistent buy/sell sides, time order, flows re-derived from the raw transfers.
2. **API vs fresh SQL:** every headline number (totals, per-exchange, PancakeSwap, charts, histogram, CSV exports, top wallets, wallet profile) recomputed independently, for the all-time, 30-day and 7-day views.
3. **Database vs blockchain:** about 60 transfers and 80 swaps are sampled and compared with the on-chain receipts (addresses, exact amounts, block, timestamp, buy/sell side, and that the stored trader is the transaction signer).
4. **Balances:** stored IN − OUT against the live on-chain balance of each monitored address. A small difference is expected while the current UTC day is not yet synced.
5. **Prices:** each pool's on-chain price against CoinGecko and our last stored trade.
6. **Dune aggregates:** counts and exact sums from `backend/queries/dune/verify/08_audit_transfers.sql` and `09_audit_swaps.sql`. Run them first from `backend/` with `node scripts/dune-run.mjs queries/dune/verify/<file> --start "…" --end "…"` (about 2.6 credits for an 11-day window); the audit reads `.dune-output/`.

## API

These read endpoints take `range=1h|6h|24h|7d|30d|all|custom` (with `from` and `to` for custom). The ones marked CSV also accept `format=csv`; exports include the raw transaction hash and a BscScan link.

| Endpoint | Returns |
|---|---|
| `/api/price` | Live DEOD/USD price, 24h change, volume and market cap from CoinGecko. Cached for 60 s; if CoinGecko is down it serves the last good value (`stale: true`) for up to 10 min, then returns 503. |
| `/api/overview` | Dashboard summary |
| `/api/flows` | Exchange flows. Filters: `exchange`, `direction`, `wallet`, `min`, `max`, `sort`. CSV. |
| `/api/activity` | Every monitored transaction together: exchange transfers and PancakeSwap swaps, newest first, with common columns (`type`, `venue`, `action`, `wallet_address`, `counterparty`, `deod_amount`, `quote_amount`, `price`, `usd_value`, `tx_hash`…). CSV. |
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
