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

## Going live

Before putting DEODScan on a server others can reach, read **docs/GOING_LIVE.md**: the settings that must be set, HTTPS and keeping the API private, keeping the processes alive, backups, monitoring (`GET /api/health` reports data freshness), the built-in cost limits (Dune per-run credit and time limit, daily AI question limit) and what to do when something goes wrong.

## Ask DEODScan AI

The **Ask AI** button in the top bar opens a chat panel where you ask questions about the DEOD data in plain language ("Which exchange had the largest withdrawal this month?"). It uses **OpenAI's API**; without a key it is switched off and nothing else is affected.

**Set up:** create an API key at platform.openai.com (a separate paid account: set a spending limit there), then in `backend/.env` put `OPENAI_API_KEY=...`, and `OPENAI_MODEL=` a model your key can use (default `gpt-4.1`; check with `npx tsx worker/src/cli.ts ask-check`, which lists the models your key can use and spends nothing; add `--question "..."` to ask one real question, a few cents). `ASK_DAILY_LIMIT` (default 100) is the most questions per UTC day. Restart the backend (this also applies migration `006_ask_usage.sql`).

**How it stays accurate:** the model never writes SQL and never sees anything but what 11 read-only tools return; each tool is a thin wrapper around a query the dashboard already uses (overview, summary, exchange stats, transfers, swaps, top wallets, wallet profile, alerts, data coverage). Before an answer is shown, **every figure in it is looked up in the tool results**; a figure that is not there (invented or computed by the model) makes the answer fail the check, the model gets one chance to correct it, and if it still fails the answer is withheld and only the retrieved data is shown. Each answer has a "Supporting data" section with the rows and transaction links behind it, and says when data is incomplete (synced once per finished day; exchanges whose history starts later; only recorded transfers).

**Ready-made questions:** the panel opens with a list of common questions to tap (exchanges, PancakeSwap, wallets and alerts, about the data), and the list stays one tap away under "Common questions" during a conversation. Four **instant** ones (summary of the last 24 hours, 7 days, 30 days, all history) are answered from the dashboard summary with fixed rules: no AI, no cost, and they work even before an OpenAI key is set. The assistant also remembers the last three questions of the conversation, so follow-ups such as "show me the addresses" work; figures from earlier answers are not trusted and are looked up again.

**Limits and privacy:** the question and the data the tools return (public on-chain figures, addresses, hashes) are sent to OpenAI; questions and answers are not stored (only daily counters). The panel is behind the dashboard sign-in. Answers can still be incomplete or misread: use the supporting data. The AI never labels wallets (whale, bot...) and gives no predictions or advice.

## Dashboard summary

The **Summary** card at the top of the dashboard describes, in plain sentences, what the page shows for the selected period: exchange deposits and withdrawals and the net flow, each exchange's activity, the largest single transfer, PancakeSwap buying and selling, the change against the previous period of the same length, the alerts raised, and notes on what the data cannot show (data is synced once per finished UTC day; exchanges whose recorded history starts later). **Copy summary** copies it as text. API: `GET /api/summary?range=...`.

It is written by fixed rules from the same numbers as the cards and tables (no AI, no estimates), so it always agrees with the page and costs nothing. An AI model could later reword it, but would have to be given exactly these numbers.

## Alerts and wallet watching

The **Alerts** page lists automatic alerts and manages a watchlist of wallets. Detection is plain rules on data already in the database; no AI and no Dune calls are involved, so it costs no credits and works without any AI key.

| Rule | Raises an alert when | Default (`backend/config/alerts.yaml`) |
|---|---|---|
| Large exchange transfer | one deposit/withdrawal on a monitored exchange address is at least X | 500,000 DEOD |
| Large PancakeSwap swap | one swap is at least X | 50,000 DEOD |
| Unusual exchange flow | a finished UTC day's total IN (or OUT) for an exchange is at least 3x its 30-day daily average and at least X | 250,000 DEOD, needs 14 days of history |
| Watched wallet activity | a recorded transfer or swap involves a wallet on your watchlist | any amount (set a minimum per wallet) |

- Each alert shows the amount, sender, recipient, time, transaction hash and a block explorer link (daily-flow alerts show the baseline instead of a transaction).
- Alerts are created after every sync (and after **Update today**). They are stored once: the same transfer can never alert twice, even if a sync or scan is repeated. Transfers older than 7 days never alert, so a backfill creates no flood.
- To scan the stored data right now (database only, no credits): `npx tsx worker/src/cli.ts alerts` in the backend folder. `--rescan` re-reads the last 7 days (it can add alerts for a wallet you started watching after its activity was scanned, but never duplicates).
- **Limits:** monitoring covers only recorded transactions (transfers to/from the monitored exchange addresses and swaps on the monitored pools). It cannot see other wallet transfers, and data arrives once per finished day or when you press Update today, so alerts are not real time. A wallet added to the watchlist alerts only on activity recorded afterwards.
- The first start after this update applies database migration `003_alerts.sql` automatically (new tables only; nothing existing is changed).

### Telegram alerts with an access code (free, optional)

Alerts can also reach people on Telegram. Nobody gets in without the access code you choose, and nobody gets alerts without saying yes. Detection never depends on Telegram: with no bot configured, or if Telegram is down, alerts are still stored and shown on the Alerts page.

**Set up (once):**
1. In Telegram, message **@BotFather**, send `/newbot`, and copy the **bot token**.
2. Choose an **access code**: a long secret of at least 8 characters. You give it to the people you want to allow in.
3. In `backend/.env` (never in git) set `TELEGRAM_BOT_TOKEN=...` and `TELEGRAM_ACCESS_CODE=...`, then restart the backend (`npm run dev`). This also applies migration `005_telegram_bot.sql`. The old `TELEGRAM_CHAT_ID` line is no longer used and can be deleted.
4. Check the token: `npx tsx worker/src/cli.ts telegram-check` (sends nothing). Check delivery: `npx tsx worker/src/cli.ts telegram-test` sends one clearly marked TEST message to everyone who is subscribed (it is not an alert and is not stored).

**What a person does:**
1. Opens your bot and presses **Start**. The bot asks for the access code.
2. Sends the code. If it is right, they are let in (the bot also deletes their message with the code) and are asked: **"Do you want to receive DEOD alerts here?"** with buttons *Yes, send me alerts* / *Not now*.
3. After **Yes**, they receive every new alert (amount, sender, recipient, time, transaction hash, explorer link). Under the bot's messages there is a button menu, so nobody has to type commands: **Latest alerts** (the 5 most recent), **Status**, and **Turn alerts off / Turn alerts on**. The old typed commands (`/latest`, `/status`, `/stop`, `/subscribe`) still work.

**Rules:**
- Five wrong codes lock that chat for 60 minutes; 30 wrong codes from all chats within an hour pause code checking for everyone. The bot answers private chats only and ignores groups.
- A person receives only alerts created after they said yes, each alert once. At most 20 messages per person per run (a burst continues on the next run). A failed delivery is retried up to 5 times. If someone blocks the bot they are moved back to "allowed, alerts off".
- See who is in: `npx tsx worker/src/cli.ts telegram-users`. Turn someone away for good: `--revoke <chat_id>` (the bot then ignores them); `--restore <chat_id>` undoes it. Changing the access code does not remove people who are already in; revoke them.
- The bot reads its messages inside the backend API process (it is on whenever `npm run dev` runs and the two settings are present). Run only one copy of the backend per bot, or Telegram reports a conflict.
- Alerts are sent after each sync, "Update today" and `npx tsx worker/src/cli.ts alerts`, so they are not real time.

## Sign-in (admin only)

The whole dashboard sits behind a sign-in page for one admin (Bimal Pradhan). Without a valid session every page redirects to `/login`, and the page scripts' routes (`/api-price`, `/api-refresh`, CSV exports) answer 401.

1. Open `frontend/.env.local` (created for you, not in git) and put your password after `ADMIN_PASSWORD=`. Use a long passphrase. `AUTH_SECRET` (signs the session cookie) is already filled in; keep it secret.
2. Restart the dashboard (Ctrl+C, then `npm run dev` in `frontend`), open it and sign in. You stay signed in for 30 days; **Sign out** is in the header.
3. Five wrong passwords from one address (or twenty from anywhere) lock sign-in for 15 minutes.

Before putting it on the internet:
- Serve it over HTTPS (Vercel does). The session cookie is marked Secure when the request arrives over HTTPS.
- Keep the backend API **private** (do not expose port 4000). As a second lock set the same long random `INTERNAL_API_KEY` in `backend/.env` and `frontend/.env.local`: the API then refuses any request without it.
- Set `REFRESH_TODAY_ENABLED=false` in `backend/.env` only if you do not want the Update today button at all (it already needs a signed-in session).
- Run the dashboard on one server instance: the lockout counter is kept in memory, so on serverless hosting it is per instance and weaker; the password length is the real protection.

## Automatic updates of today (twice a day)

While the **worker** is running (`npm run dev:worker`, or the worker on a server), it also fetches today's unfinished day by itself **twice a day**, by default at **06:00 and 14:00 UTC** (11:30 AM and 7:30 PM in India). This is separate from the daily sync of finished days (about 02:00 UTC) and uses the **same daily budget as the button**: 2 updates per UTC day in all, automatic and manual together, so the cost stays at about 0.4 to 1.4 Dune credits each and at most a few credits a day. Rules:

- At each scheduled time the worker runs one update unless today's data was already updated since that time (a manual press counts), the daily limit is used up, or the last update was under 10 minutes ago.
- If the worker was off at a scheduled time, only the most recent missed time is made up when it starts, not every missed one.
- A failed attempt counts as one of the day's updates (Dune may have billed the run) and is not retried until the next scheduled time.
- Settings in `backend/.env`: `AUTO_UPDATE_TODAY=false` switches it off; `AUTO_UPDATE_TODAY_AT=06:00,14:00` sets the UTC times (up to 6); `REFRESH_TODAY_MAX_PER_DAY` is the shared daily budget.
- See what it would do right now, without spending anything: `npx tsx worker/src/cli.ts auto-check` (add `--run` to perform the update if it is due).
- The button's tooltip lists the automatic times in your own time zone.

## "Update today" button

The worker syncs only **finished** UTC days, so today's transfers appear after the day ends (about 02:00 UTC the next day). The **Update today** button in the dashboard header fetches today's unfinished day so far, on demand:

- It asks first, because each fetch uses Dune credits (about 0.4 to 1.4, measured). **It can be used 2 times per UTC day** (`REFRESH_TODAY_MAX_PER_DAY`, default 2; automatic and manual updates share this budget; the count resets at 00:00 UTC and also applies to the terminal command), with at least 10 minutes between two uses (`REFRESH_TODAY_COOLDOWN_MINUTES`). The button shows how many uses are left ("Update today · 2 left") and switches itself off, with the reason in its tooltip, when none are. A use that started counts even if it failed, because Dune bills a started run. At most about 2 credits a day on top of the automatic daily sync.
- The rows are stored with the normal duplicate protection. The next daily sync fetches the whole day again and adds nothing twice; the daily checkpoint is not moved.
- It needs the backend running (`npm run dev`), but not the worker. The same thing from a terminal: `npx tsx worker/src/cli.ts today`.
- On a public server set `REFRESH_TODAY_ENABLED=false` in `backend/.env`: anyone who can open the page could otherwise press it and spend credits. The button then disappears.

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
