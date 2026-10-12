# HANDOFF — DEOD On-Chain Monitor

> **Standing rule for every Claude session (any account / Claude ID):**
> You are responsible for keeping this file current, automatically, without the user asking.
> The user may switch Claude accounts at any time and will NOT remind you. Read this file at the
> start of every session, and update it (Work log + Current state + Next steps) whenever you change
> code, config, queries, data, or decisions. Do not wait until the end of the session. Short entries
> are fine; skipping them is not.

Last updated: 2026-10-12

---

## 1. What this project is

A read-only dashboard tracking DEOD token movement on **BNB Chain only**:
- DEOD flowing into/out of monitored **MEXC** and **Toobit** addresses (BitMart was removed on 2026-10-05, see §3)
- DEOD buys/sells in **PancakeSwap V2 and V3** DEOD/USDT pools

Pipeline: `Dune ──► worker ──► PostgreSQL ──► API (Fastify, :4000) ──► Web (Next.js, :3000)`.
No private keys, no exchange APIs, never signs or trades. Full details: [README.md](README.md).

**Source spec:** [docs/ORIGINAL_BRIEF.md](docs/ORIGINAL_BRIEF.md) is the owner's full brief, saved word for word. Read it before changing scope.
It required phased delivery (§29): verify addresses → Dune queries → Dune API → Postgres → analytics → dashboard → backfill → incremental sync → exports and wallet pages.

### Deliberate differences from the brief

| Brief said | Built | Why |
|---|---|---|
| V2 = `0x185d…1f1f`, V3 = `0xd693…1d20` | Labels swapped | Pool `factory()` calls and factory lookups proved the brief had them reversed |
| One query per exchange and direction (`mexc_inflow.sql`, etc.) | A single `exchange_transfers.sql` covering all monitored addresses; IN/OUT worked out in Postgres | One scan is cheaper in Dune credits and gives the same rows |
| Toobit = `0xb0b1…aa77` | Kept, labelled `custody_wallet` | Dune labels it Cobo custody; the owner decided on 2026-10-02 to treat it as Toobit |
| `database/migrations/` | `packages/db/migrations/` | Migrations live inside the db package |
| Trader / sender | Trader = `tx_from` | Dune's `taker` is a router contract in ~74% of swaps (brief §7 warned about this) |

## 2. Repo map (layout since 2026-10-12: frontend/ and backend/ are separate projects)

| Path | What it is |
|---|---|
| `frontend/` | The dashboard (Next.js 16, React 19, Tailwind 4, Recharts). Standalone project: own `package.json`, `package-lock.json`, `node_modules`. Imports nothing from the backend; talks to the API over HTTP only (`API_BASE_URL`, default `http://localhost:4000`). `app/` pages, `components/`, `lib/` (`api.ts`, `format.ts`, `colors.ts`, `series.ts`, `site.ts` for the greeting name and quotes). |
| `backend/` | Standalone project (npm workspaces: `api`, `worker`, `packages/*`; own `package.json`, lockfile, `node_modules`). |
| `backend/api/` | Fastify API (`src/server.ts`, `src/price.ts`, `src/csv.ts`) on port 4000. |
| `backend/worker/` | Daily Dune sync (`src/index.ts` loop, `src/sync.ts`, `src/cli.ts`). Also imported by the API as `@deod/worker` for the admin sync endpoint. |
| `backend/packages/config` | Loads `config/deod.yaml` and `.env` (`backendRoot()` finds the backend folder by walking up to `config/deod.yaml`). |
| `backend/packages/core` | Pure logic and the unit tests (`test/core.test.ts`). |
| `backend/packages/db` | PostgreSQL access, migrations (`migrations/`), `deriveExchangeFlows`, wallet summary. |
| `backend/packages/dune` | Dune API client and SQL template rendering. |
| `backend/packages/analytics` | The SQL behind every dashboard number. |
| `backend/config/deod.yaml` | All verified addresses (token, pools, exchanges) and how each was checked. |
| `backend/queries/dune/` | Production SQL (`exchange_transfers.sql`, `pancakeswap_swaps.sql`); `verify/` = one-off checks (08/09 are the audit aggregates). |
| `backend/scripts/` | `audit.mjs` (`npm run audit`), `remove-exchange.mjs`, `dune-run.mjs`, `dev-postgres.mjs`. |
| `backend/archive/` | Data removed from the database, kept as CSV (BitMart's history). |
| `backend/.env`, `backend/.pgdata/`, `backend/.dune-output/` | Secrets, local database files, Dune query outputs. All git-ignored. |
| `docs/ORIGINAL_BRIEF.md` | The owner's original spec. |
| `scripts/start.ps1`, `scripts/stop.ps1`, `run.cmd`, `stop.cmd` | Start and stop everything on Windows (see §5). |
| root `package.json` | Thin: forwards commands to `backend/` and `frontend/` (`npm run api`, `worker`, `web`, `sync`, `audit`, `typecheck`, `test`, `install:all`...). No code, no dependencies. |

**Old paths in the log:** entries dated before 2026-10-12 use the old layout. Map: `apps/web` → `frontend`; `apps/api` → `backend/api`; `apps/worker` → `backend/worker`; `packages/*` → `backend/packages/*`; `config/`, `queries/`, `archive/`, `scripts/{audit,dune-run,remove-exchange,dev-postgres}` → under `backend/`; root `.env`, `.pgdata/`, `.dune-output/` → under `backend/`; `.env.example` → `backend/.env.example`.

## 3. Key decisions & verified facts (do not re-litigate)

- **BNB Chain only.** Never discover or monitor other chains; filter `blockchain='bnb'` first.
- **The V2 and V3 pool labels in the original brief were swapped.** `config/deod.yaml` and the README have the corrected labels.
- **Toobit address** `0xb0b1…aa77` is labelled "Cobo 4" by Dune (a custody provider). The owner decided it counts as Toobit.
- Other Dune-labelled MEXC/BitMart/Cobo addresses each only ever received 5–15 DEOD, so they are listed in the config but not monitored.
- **BitMart was removed on 2026-10-05 (owner decision: "since it's no longer working").** Its address `0xa23e…3f1a` had no DEOD transfer after 2026-08-19. Its 1,052 stored transfers were archived to `archive/bitmart-removed-2026-10-05.csv` and deleted from the database. It is gone from the config, the API, the menu and all totals. The brief (`docs/ORIGINAL_BRIEF.md`) still lists BitMart; that is the original spec and is left unchanged.
- Flow data was complete on 2026-10-02: IN minus OUT matched the on-chain balance for every monitored address.
- Trader = `tx_from` (the transaction signer). Dune's `taker` is stored as the recipient; it's a router in ~74% of swaps.
- Amounts are exact `NUMERIC`. Dune is asked for raw amounts as text, and decimals travel as strings in the API.
- USD values assume USDT = $1 (recorded in `usd_basis`).
- Dedup key `(chain, tx_hash, evt_index)`. No behavioural labels (whale/bot) are ever assigned.

## 4. How the user wants to work

- **Phase-gated.** Verify with real Dune data and show the evidence before building on it. Never guess tables, columns or addresses.
- **Dune costs the user credits.** Mention the cost and ask before expensive or exploratory queries.
  - Full transfer history is about 22 credits.
  - Joining `tokens.transfers` to label tables once cost 293 credits, so never do that. Use explicit address lists and time windows.

## 5. Current state

- Code for all components (worker, API, web, packages, migrations, queries) is written; see the README for run commands.
- Git: branch `master`. The initial commit `49ad266` (2026-10-03) holds everything. The default/PR branch is `main`.
- **Running on the owner's PC (restarted 2026-10-05 ~09:50 UTC after a PC shutdown; before that since 2026-10-03), as detached hidden processes:**
  - Postgres on :5433, started with `pg_ctl`.
  - Worker, which checks hourly.
  - API on :4000 and web on :3000; open http://localhost:3000.
  - Logs: `logs/worker.log`, `logs/api.log`, `logs/web.log` (git-ignored).
  - These **do not survive a reboot**. **To start: run `.\run.cmd` (or double-click it) in `G:\Monitor`; to stop: `.\stop.cmd`.** They start the database (`pg_ctl`, detached, waiting for "ready to accept connections"), then the API, web and worker, and wait until they answer. Options: `-NoWorker` (no Dune credits), `-NoBrowser`, `-Hidden`. Safe to run twice. See the README, "Starting and stopping (Windows)". (The scripts now use `backend\.pgdata`, `backend\.env` and `backend\node_modules`.) Logs of the manual hidden starts used before 2026-10-12 were in `logs/`; `run.cmd` shows each service in its own window instead.
  - Gotcha: if a port is already taken, the new process logs `EADDRINUSE` and exits while the old process keeps serving. Check the logs after a restart.
- Checks (2026-10-03): `npm test` passes (22/22). `npm run typecheck` is clean. The web app (`apps/web`, which the root typecheck does not cover) is also clean with `npx tsc --noEmit`.
- Local DB (`npm run db:dev`, data in `backend/.pgdata/`), counted 2026-10-03:
  - **Sync model (owner decision 2026-10-03): daily, going forward. No historical swap backfill.**
  - Each completed UTC day is fetched once, as a whole [00:00, 24:00) window, `SYNC_SETTLE_HOURS` (default 2) after it ends. The current day is never fetched.
  - The worker checks hourly; a check with no new day makes no Dune call.
  - Code: `completedDayWindows` in `packages/core`, `syncCompletedDays` / `syncAllCompletedDays` in `apps/worker/src/sync.ts`. CLI: `npm run sync -- daily`. `POST /api/admin/sync` runs the same.
  - The old intraday `incremental` sync and `SYNC_OVERLAP_HOURS` were removed.
  - The dashboard shows "Data through …" (`/api/meta` `dataThrough` = min `synced_until`).
  - The first daily fetch will be all of 2026-10-03, after 2026-10-04 02:00 UTC. That day was partly loaded up to 06:44 by the catch-up sync; already-stored rows are skipped.
- `token_transfers`: 5,681 rows, 2026-01-09 → 2026-10-02 08:47. Full history from the 2026-01-01 backfill.
  - `exchange_flows` (2026-10-03 snapshot, includes BitMart, later removed): MEXC 2,337 IN / 1,312 OUT · BitMart 442 / 610 · Toobit 715 / 265. **Now (2026-10-05, after the BitMart removal):** MEXC 2,386 IN / 1,313 OUT · Toobit 717 IN / 266 OUT; 4,682 transfers, 1,218 wallets, 6,228 swaps.
  - `dex_swaps`: **only 2026-09-25 → 2026-10-02.** V2 has 995 rows, V3 has 4,456. The swap backfill started at 2026-09-25, not 2026-01-01.
  - `ingest_rejections` 0, `wallet_summary` 1,203.
  - Dune credits spent: about 22.3 on transfers and 1.6 on swaps, plus 2.6 on the 2026-10-03 swap-count check.
  - **Data now runs through 2026-10-05 00:00 UTC** (every completed day synced; 2026-10-05 is still in progress and is fetched after 02:00 UTC on 2026-10-06).
  - Daily-sync checks: 2026-10-03 and 2026-10-04 were fetched on 2026-10-05 for both queries, 0 rejected, about 0.31 credits in total.
- **Swap volume in Dune** (from `verify/07_swap_counts.sql`, 2026-01-01 → 2026-10-03): **92,486 swaps**.
  - V3 has swaps from 2026-01-14 onward. V2 only from **2026-05-19**, when that pool was created.
  - Peak month: Aug 2026, with 15.2k V2 swaps.
  - Backfilling 2026-01-01 → 2026-09-25 means about **87k rows ≈ 230 credits** (at ~2.6 credits per 1k rows).

### Local Postgres gotcha (paths updated for the backend/ layout; `run.cmd` / `stop.cmd` do this for you)
`npm run db:dev` runs Postgres as a child of a node wrapper. If the wrapper is killed (for example by a tool's background time limit), Postgres keeps running in a broken state: connections get `ECONNRESET`, and a restart fails with "postmaster.pid already exists". To fix it:
```
backend/node_modules/@embedded-postgres/windows-x64/native/bin/pg_ctl.exe -D backend/.pgdata stop -m fast
backend/node_modules/@embedded-postgres/windows-x64/native/bin/pg_ctl.exe -D backend/.pgdata -o "-p 5433" -l backend/.pgdata/server.log -w start
```
Starting with `pg_ctl` directly, as in the second line, runs the server detached and avoids the problem.

## 6. Next steps / open items

- [x] ~~Swap backfill 2026-01-01 → 2026-09-25~~: the owner declined on 2026-10-03; only daily monitoring going forward is needed. Swap history starts 2026-09-25. Don't re-propose this unless asked.
- [x] Worker running on the owner's PC (2026-10-03). It only syncs while the PC is on and the processes are up.
- [ ] For always-on monitoring: move to a server (VPS + `docker-compose.yml` Postgres) or set the processes to start on Windows startup. Waiting on the owner's choice.
- [x] First daily syncs confirmed on 2026-10-05 (caught up 2026-10-03 and 2026-10-04; 0 rejected).
- [ ] Optional: the 1h/6h/24h ranges count back from the current time, so with daily data they show little or nothing for today. The owner may want them to count back from "data through" instead.
- [ ] Make the initial git commit (only when the user asks).

## 7. Work log (newest first)

Format: `YYYY-MM-DD — what changed — files — why/notes`

- 2026-10-12 — **Frontend and backend separated and restructured** (owner: "separate the frontend and the backend part, structure it properly"). A pure move and re-wiring: no behaviour change, no data change, 0 Dune credits.
  - **New layout:** `frontend/` (the dashboard, was `apps/web`) and `backend/` (`api/`, `worker/`, `packages/`, `config/`, `queries/`, `scripts/`, `archive/`, `.env`, `docker-compose.yml`, was `apps/api`, `apps/worker`, `packages/`, `config/` ...). The full map is in §2, and the README has a "Project layout" section with the command table.
  - **Two independent npm projects:** `frontend/` and `backend/` each have their own `package.json`, lockfile and `node_modules` (the old single hoisted `node_modules` and the root workspace are gone). The root `package.json` is only a launcher that forwards commands, so `npm run api`, `worker`, `web`, `sync`, `db:*`, `typecheck`, `test` and `audit` still work from the root. New: `npm run install:all`, `npm run web:build`. The frontend already imported no backend code, so nothing in the code had to be decoupled.
  - **Code changes (small):** `repoRoot()` was renamed `backendRoot()` (`packages/config`, `packages/dune`); `scripts/dev-postgres.mjs` now locates `backend/.pgdata` itself instead of using the current folder; `frontend/next.config.ts` uses its own folder as the Turbopack root; tsconfig `extends` paths in `backend/api` and `backend/worker` point one level up; `scripts/start.ps1` / `stop.ps1` use `backend\.pgdata`, `backend\.env`, `backend\node_modules` and install both parts on a first run. `frontend/` got `@types/node` of its own (it had been borrowing the hoisted one) and a `typecheck` script. `.env` moved to `backend/.env`; each part has its own `.env.example` (the frontend's only setting is `API_BASE_URL`).
  - **Safety:** before moving anything, the database folder was copied to `G:\Monitor_backup\pgdata-2026-10-12` (outside the project) with `.env` as `env-2026-10-12.txt`, and exact table counts were recorded. `git mv` was used, so file history is kept. The backup folder can be deleted once the owner is happy.
  - **Verified:** all 25 key dependencies are at exactly the same versions as before (the old lockfile seeded both installs); backend and frontend type-check clean; 27/27 tests; the database is **identical** to the pre-move snapshot (every table count and the exact raw sums; migrations report none pending); `run.cmd` starts from the new layout and `stop.cmd` stops it cleanly; the worker finds its SQL templates and config; the worker CLI boots; all 9 pages return 200; the browser sweep (11 pages × phone/desktop) has 0 overflow and 0 console errors; the on-screen numbers match the API (12/12); the greeting still shows once; the export menu works; `npm run audit` has 0 failures; and a production `next build` of the frontend succeeds on its own.
  - **Gotcha found and fixed (TypeScript):** the first time Next ran in `frontend/` it silently added `typescript: 7.0.2` (a major version newer than the project's 5.9.3) to `frontend/package.json`. It is now pinned to `^5.9.3`, the same line as the backend, and the frontend type-checks and builds on it. If Next adds anything to `frontend/package.json` by itself again, review `git diff` before committing. Keep both parts on the same TypeScript major.
  - **Not a regression:** `npm run audit` now lists the MEXC and Toobit balances as informational differences from the live chain, because the data is 4 days behind (it runs through 2026-10-07; the worker has not run since 2026-10-08). They will match again after the worker catches up.
  - Everything was left **stopped**. When the owner starts it, the worker fetches the missed days (2026-10-08 to 2026-10-11) by itself.
- 2026-10-12 — **Owner wants to run the project themselves** ("let me run it by myself; tell me how and from which folder"). Added one-click scripts instead of four manual commands. 0 credits.
  - **New files:** `run.cmd` and `stop.cmd` in the project root (thin wrappers that call `scripts/start.ps1` and `scripts/stop.ps1` with `-ExecutionPolicy Bypass`, so Windows script-policy settings cannot block them), documented in the README ("Starting and stopping (Windows)").
  - **`run.cmd`:** checks `.env` and the packages, starts Postgres with `pg_ctl` (waits up to 150 s for crash recovery), then the API, web and worker, each in its own titled window (`DEODScan API`, `DEODScan Web`, `DEODScan Worker`), waits until `/api/health` and the dashboard answer, and opens http://localhost:3000. It skips anything already running (so running it twice is harmless). Options: `-NoWorker`, `-NoBrowser`, `-Hidden`.
  - **`stop.cmd`:** kills the three windows and their process trees, anything left on ports 3000 and 4000, the worker (found by its command line), and stops Postgres cleanly with `pg_ctl stop -m fast` so the next start is quick.
  - **Name:** the first name `start.cmd` was renamed `run.cmd` because `start` is a built-in Windows command, and because PowerShell needs `.\` in front of a file in the current folder.
  - **Tested** (`-NoWorker -NoBrowser -Hidden`, so no popups and no credits): everything starts from cold, all pages return 200, a second run leaves everything alone, `stop.cmd` leaves no listeners on 3000/4000/5433 and no leftover processes. Both `.cmd` wrappers were tested end to end. Everything was left **stopped** so the owner can run it themselves.
  - **When the owner starts it:** data runs through 2026-10-08 00:00 UTC, so the worker will fetch the missed finished days (2026-10-08 to 2026-10-11, 4 days) by itself: usually about 0.5 credits per day, with occasional spikes of about 8 (see the 2026-10-08 entry).
- 2026-10-08 — Owner said "run it" (several times). The PC had been restarted again, so Postgres, the API, the web app and the worker were all down, and 2026-10-06 and 2026-10-07 were unsynced.
  - **Restart:** same steps as before (§5): Postgres via `pg_ctl` run detached, waiting for "ready to accept connections" (it does crash recovery for about 35 s), then the API, web and worker as detached processes. The data was intact (4,685 transfers, 6,401 swaps, 2 exchanges). No port conflicts.
  - **Catch-up (automatic):** the worker fetched both missed days, 0 rejected, 0 errors. Transfers: 2026-10-06 +14, 2026-10-07 +11. Swaps: 2026-10-06 +190, 2026-10-07 +238. Data now runs through **2026-10-08 00:00 UTC**. Total cost **8.72 credits** (see below).
  - **Credit cost note:** the exchange-transfers query for 2026-10-06 cost **8.24 credits** for only 14 rows, against about 0.07–0.39 on other days. **Dune's cost follows execution time, not result size.** That run took 97 s; the normal 10–15 s runs cost under 0.4. The initial history load shows the same (81 s = 8.05 credits, 50 s = 5.21). So a slow or cold Dune execution costs up to about 8 credits no matter how little data returns. Nothing in our query changed. A normal day is about 0.5 credits; expect occasional spikes of about 8. It cannot be tuned from our side (the default `medium` performance tier is already the cheapest). If spikes become frequent, tell the owner. Lifetime credits recorded by the sync: transfers 31.26 + swaps 2.09 = 33.35, plus about 5.2 for the swap count and the audit aggregates.
  - The owner's PC has now been restarted three times (2026-10-05, 2026-10-06, 2026-10-08). The always-on options (start with Windows, or a small server) are still open and are worth raising again.
- 2026-10-06 — **Less blue: neutral graphite theme with violet accents** (owner: "it looks more blue blue, the whole UI"). Frontend only; 0 credits.
  - **Cause:** the navy base (page/cards/sidebar), blue-tinted borders and glows, and cyan-blue buttons, menu highlight and links all added up. The data blue (inflow) was lost in it.
  - **Change** (`app/globals.css` and a few components): the base is now neutral graphite (page `#0c0c0f`, cards `#16161b`, sidebar `#101014`, borders white-based, faint violet/magenta backdrop glow). The UI accent (buttons, active menu item and time-range, links, focus, progress bar, icon badges) is the **brand violet**, matching the logo. Magnitude bars with no direction (top-wallet volume) are violet too.
  - **Rule kept:** blue now appears **only** as data: inflow / IN / BUY, plus the blue share ramp of the inflow donut. Orange = outflow, aqua = net. Violet is chrome and never a data series. Do not use blue for chrome again.
  - **Colour checks:** the series colours (blue/orange/aqua) and both share ramps were re-validated on the new surfaces `#16161b` and `#101014` with `validate_palette.js`: all pass.
  - **Checks:** typecheck is clean for the API and web, 27/27 tests pass, 11 pages × 2 sizes have 0 overflow, and the rendered-numbers UI check passes 12/12. **`next build` succeeds**, and the production build (served on a temporary port, then stopped) has **0 console errors and 0 overflow on all pages**, including the themed 404 for `/BitMart`.
  - **Dev-only message:** in `npm run web` (the dev server), `/BitMart` logs "Failed to execute 'measure' on 'Performance': 'Venue' cannot have a negative time stamp" on every load (5/5). It is React's development profiling around `notFound()`; it does not occur in the production build. Ignore it, or fix it only if it starts to matter.
  - **Renames:** the CSS class `badge-icon cyan` is now `badge-icon brand`. The accent token is `--accent` = `#8b6cff`. `barStyle()` defaults to the `accent` tone.
- 2026-10-06 — **Full data audit** (owner: "verify the data on our dashboard is correct and accurate, cross-verify it"). Result: **everything passes, 0 failures.** Cost: **2.58 Dune credits** (2.34 for the transfers aggregate, 0.24 for swaps; window 2026-09-25 → 2026-10-06).
  - **New reusable tool:** `npm run audit` (`scripts/audit.mjs`; read-only, no credits; `--no-chain` skips the blockchain sampling) and two Dune aggregate queries, `queries/dune/verify/08_audit_transfers.sql` and `09_audit_swaps.sql` (counts and exact raw sums per address/direction and per pool). It is documented in the README ("Data audit"). Latest full run: **40 passed, 0 failed, 5 informational.**
  - **What was verified, and how**
    1. **Database rules** (13 checks): no duplicates; no negative or zero amounts; no stray or self-transfers; `exchange_flows` equals the raw transfers re-derived (exact raw sums per exchange and direction); swap amounts × 10^decimals equal the raw integers exactly (0 mismatches); price = quote / DEOD; USD = USDT; BUY/SELL consistent with the pool's token flow; time never goes backwards; PancakeSwap has swaps on every day from 2026-09-25; the wallet summary has exactly the wallets in flows and swaps (1,226).
    2. **Dashboard numbers vs independent SQL** for **all, 30d and 7d**: per-exchange inflow, outflow, deposits, withdrawals and unique wallets; totals; PancakeSwap volume, buy/sell, USD, swaps, traders, largest swap and last price; the daily chart series sums to the exact totals; the hour-of-day histogram sums to the deposit and withdrawal counts; the flow CSV and the all-activity CSV have the right row counts and exact amount totals; the top-10 wallets (identity, order, exact volume, transaction count); the #1 wallet's profile.
    3. **Database vs blockchain:** 59 transfers (largest, earliest, latest, random) and 79 swaps (V2 and V3: largest, earliest, latest, random) match the on-chain receipts exactly: addresses, amounts (every digit), block number, timestamp, buy/sell side, quote amount. **79/79 stored traders are the transaction signer, and 79/79 stored recipients are the Swap event recipient**, so the "trader = tx signer" attribution is confirmed.
    4. **Balances:** Toobit matches the chain exactly (11,944,475.7613 DEOD). MEXC differs by +3,697.59 DEOD, which is 2026-10-06's activity not yet synced (expected; it matched exactly at the previous boundary, see the entry below).
    5. **Prices:** V2 pool $0.01901 and V3 pool $0.01902 (read from the pools on-chain) vs CoinGecko $0.01900: within 0.04% and 0.11%.
    6. **Dune aggregates** (independent aggregate queries, not the row-by-row ingestion): for 2026-09-25 → 2026-10-06, MEXC IN 143 / OUT 13 and Toobit IN 17 / OUT 3 match our transfer counts **and exact raw sums to the last unit**; PancakeSwap V2 (1,354 swaps, 791 buys) and V3 (5,047 swaps, 2,632 buys) match our counts, buys and exact raw DEOD sums.
    7. **What the browser shows** (a scratch check, not kept): in a real browser the rendered KPI tiles, the two donut lists, the exchange cards, the PancakeSwap card, the header price and the newest rows of the recent-activity table equal the API values, for the all-time and 30-day views (cards also for 7d).
  - **Bugs found in the audit's own checks (not in the product), fixed:** (a) a "swap amounts mismatch" alarm (3,977 rows) came from Postgres division rounding to ~16 digits; exact multiplication shows 0 mismatches. (b) A UI test missed the exchange cards because it only looked at `<section>` elements. (c) A missing `AS` and a scoping slip. All were checked before the audit was trusted.
  - **Limits of what is verified:** transfers and swaps are verified by sampling (about 140 transactions); completeness comes from the Dune aggregates (11 days, exact) plus the balance reconciliation (all history, exact for Toobit; MEXC exact at each sync boundary). Older PancakeSwap history does not exist by owner decision (starts 2026-09-25). The dashboard monitors only the configured addresses (see the coverage note). USD values assume USDT = $1. CoinGecko is a third-party price feed. The current UTC day is always unsynced until after 02:00 UTC the next day.
  - To repeat the Dune cross-check for a new window: `node scripts/dune-run.mjs queries/dune/verify/08_audit_transfers.sql --start "YYYY-MM-DD 00:00:00" --end "…"` and the same for `09_audit_swaps.sql` (ask the owner first: about 2.6 credits for 11 days), then `npm run audit`.
- 2026-10-06 — Owner said "run it". The PC had been restarted again, so Postgres, the API, the web app and the worker were all down.
  - **Restart:** started Postgres with `pg_ctl` (run detached through PowerShell `Start-Process`; it spends about 35 s in normal crash recovery before it accepts connections, so wait for "ready to accept connections" in `.pgdata/server.log`). The data was intact (4,682 transfers, 6,228 swaps, 2 exchanges). Then started the API, web and worker as detached processes. No port conflicts.
  - **Catch-up:** the worker fetched the missed day 2026-10-05 by itself: transfers +3, swaps +173, 0 rejected, **0.45 credits**. Data now runs through **2026-10-06 00:00 UTC**. 2026-10-06 is fetched after 02:00 UTC on 2026-10-07.
  - **MEXC balance question from 2026-10-05: resolved, exact.** Yesterday the chain showed MEXC at 24,350,233.0134 DEOD (we were 2,769.51 DEOD higher). After syncing 2026-10-05, the stored total is exactly 24,350,233.0134, so the gap was exactly that day's unsynced activity. Toobit matches the chain exactly (11,944,475.7613 DEOD, including a +1,000 transfer from 2026-10-05). Today's difference for MEXC (+3,697.59) is 2026-10-06's activity so far, not yet synced, which is expected by design. Free check: compare the chain balance with the stored total right after a sync; it will match for any address with no activity since 00:00 UTC.
  - Worth knowing: the owner's PC has now been restarted twice (2026-10-05 and 2026-10-06). The restart steps (§5) work every time; the always-on options (start with Windows, or a small server) are still open.
- 2026-10-05 — **Dashboard CSV export now includes PancakeSwap** (owner: "while downloading CSV from the dashboard I only see CEX transactions, not PancakeSwap"). **Cause:** the dashboard's "Export CSV" button pointed only at `/api-export/flows` (exchange flows). The swaps CSV existed but only on the PancakeSwap and Swaps pages. 0 credits.
  - **Fix:** the button is now a menu (`components/export-menu.tsx`) with three choices: **All activity** (exchange transfers + PancakeSwap swaps in one file), **Exchange flows only**, and **PancakeSwap swaps only**.
  - **New API:** `GET /api/activity` (`listActivity` in `packages/analytics`). Columns: `block_time, type (exchange|swap), venue, action (IN/OUT/BUY/SELL), wallet_address, counterparty, deod_amount, quote_amount, price, usd_value, tx_hash, evt_index, block_number, explorer_url`. For an exchange transfer `wallet_address` is the counterparty wallet; for a swap it is the transaction signer, and `counterparty` is the exchange address or the pool. Quote/price/USD are empty for transfers. The CSV proxy allow-list in `apps/web/app/api-export/[...path]/route.ts` includes `activity`. It is unlimited (up to 1,000,000 rows), like the other CSVs; the JSON form takes `limit` (default 100, max 1,000). Documented in the README.
  - **Verified** by downloading all three files through the web proxy (the same URL the button uses) for 30d and all time: row counts equal the database exactly (all time: activity 10,910 = flows 4,682 + swaps 6,228; 30d: 6,908 = 680 + 6,228), V2 and V3 swaps are included, and every row has a BscScan link built from its tx hash. In a browser: the menu lists the 3 files, closes on Escape and on an outside click, and 0 console errors.
  - Not changed: the "Recent exchange activity" table on the dashboard still lists exchange transfers only; PancakeSwap activity is in its own card and on the PancakeSwap and Swaps pages.
- 2026-10-05 — **Rebrand to "DEODScan"** (owner: "change the colour of the logo, keep the name DEODScan in an impressive font, and use the same font for Bimal Pradhan"). Frontend only; 0 credits.
  - **Name:** the product's display name is now **DEODScan** (sidebar, splash, browser tab title, page description, footer, README title, dashboard eyebrow). Internal package names (`@deod/*`) and the repo folder are unchanged.
  - **Logo:** the gradient changed from cyan-blue to **violet → magenta** (`#8b6cff → #e155d6`) in `components/icons.tsx` (`BrandMark`) and in a new browser tab icon `app/icon.svg`. The logo is brand only: the data colours stay blue (IN), orange (OUT), aqua (net).
  - **Font:** **Unbounded** (a wide, bold display face), bundled with the project via the npm package `@fontsource-variable/unbounded` (installed in `apps/web`, imported in `app/layout.tsx`), so it works offline and makes no calls to Google. The CSS class `.font-brand` and the variable `--font-brand` are in `globals.css`.
  - **Where it's used:** the wordmark (`components/brand.tsx`: "DEOD" in white, "Scan" in the brand gradient) in the sidebar, a new small brand row at the top on phones, and the splash; and the greeting name "Bimal Pradhan". Body text keeps the system font.
  - **Checks:** the font loads in the browser (`document.fonts` reports Unbounded loaded). Typecheck is clean and 27/27 tests pass. 11 pages × 2 sizes have 0 overflow and 0 console errors. The greeting still shows once on open and 0 times across 7 section switches.
- 2026-10-05 — **Greeting now appears only once, when the website opens** (owner: "every time I switch section it greets; I want it only once when the whole website loads"). The cause was that `app/loading.tsx` (the loading screen used on every section switch) also showed the greeting. It now has placeholders only. The greeting lives only in the full-screen splash in the layout (`components/splash.tsx`), which plays once per full page load; a client-side section switch does not re-run it. Tested in a browser: visible on open, and 0 times across 7 section switches. A browser refresh still shows it once, because that is a full page load. If the owner wants it only once per browser session (not on refresh), store a flag in `sessionStorage` in the splash.
- 2026-10-05 — **BitMart removed** (owner: "remove bitmart, since it's no longer working"), plus an every-exchange health check and a PancakeSwap page tidy-up. 0 Dune credits.
  - **What was done**
    - Data: new reusable script `scripts/remove-exchange.mjs <slug> [--dry-run]`. It archives the exchange's transfers to a CSV, then deletes its rows (flows, transfers, address, exchange) in one transaction. It refuses if any transfer is shared with another monitored exchange.
    - For BitMart: 1,052 transfers archived to `archive/bitmart-removed-2026-10-05.csv`, and 1,052 flows, 1,052 transfers, 1 address and the exchange row deleted. 0 transfers were shared, so MEXC and Toobit are **unchanged** (identical counts and totals before and after). 41 wallets seen only through BitMart left the rankings (1,259 → 1,218).
    - Config and code: BitMart removed from `config/deod.yaml` (a comment records the removal; the historical discovery comments are kept as evidence), the menu, the page title, `format.ts`, README and the unit-test fixture (now uses Toobit). `/api/exchanges/bitmart` now returns 400, and `/BitMart` shows a new themed 404 page (`app/not-found.tsx`). The exchange-card grid now fits any number of exchanges (`auto-fit`).
    - The worker needs no change: it reads the monitored addresses from the database, so it no longer queries BitMart.
    - **To restore BitMart:** re-add the block to `config/deod.yaml`, restart (it re-seeds the address), then re-fetch with `npm run sync -- backfill --query exchange_transfers --from 2026-01-01 --window-days 92` (about 22 credits, ask the owner first), or re-import the archived CSV.
  - **Health check** (a scratch script, not kept): 3 services up; both sync queries `ok` through 2026-10-05 00:00; 0 rejected rows; for MEXC and Toobit the API matches the database at 24h/7d/30d/all (HTTP 200, 1–73 ms), the flows list and CSV exports are complete (3,699 and 983 rows), and PancakeSwap combined/V2/V3 swap counts match the database (6,228 / 1,305 / 4,923). All 11 pages at phone and desktop widths: 0 overflow, 0 console errors.
    - **Toobit's balance matches the chain exactly** (11,943,475.7613 DEOD).
    - **MEXC's balance does not: on-chain is 2,769.51 DEOD LOWER than stored (IN − OUT).** The likely cause is MEXC withdrawals today (2026-10-05), which the daily sync has not fetched yet (it only fetches completed days). The size is normal for a day of MEXC activity. It is plausible but NOT proven: the free public BSC node refuses log queries (`limit exceeded`) and keeps no history, so the exact check was impossible. **Resolved on 2026-10-06: see the newer entry. The gap was exactly the unsynced day.**
    - One "failed Dune run" is on record: run #1 on 2026-10-02, a bug in the credits column of the run log that was fixed the same day. The same window later succeeded. It is historical.
  - **PancakeSwap page:** the three grey technical notes (pool addresses and "factory()=V2 factory; getPair… works") were the stored proof that each address is the real DEOD/USDT pool. They are now a "Monitored pools" panel: version, pair, fee, "Verified on-chain", the address, a BscScan link, and the proof behind a "How this was verified" toggle.
  - **Checks:** typecheck is clean for the API and web, and 27/27 tests pass.
- 2026-10-05 — **Welcome greeting while loading** (owner: "while loading it should greet 'Bimal Pradhan' with a small motivation quote"). Frontend only; 0 credits.
  - **Where it shows:** a full-screen **splash** (`components/splash.tsx`) on every full page load, which dismisses itself with pure CSS after about 1.5 s plus a 0.55 s fade, so it can never get stuck or block clicks. (It first also showed in the section loading screen; that was removed later the same day, see the newer entry.)
  - **Content** (`components/greeting.tsx`): the logo, "Welcome back,", the name with a cyan gradient, one quote picked at random in the browser after mount (so the server HTML and first client render match), and an indeterminate progress bar. The quotes are unattributed generic lines that I wrote, not attributed to real people.
  - **To change the name or quotes,** edit only `apps/web/lib/site.ts` (`OWNER_NAME`, `QUOTES`).
  - **Checks:** the splash is visible at 0.7 s and hidden at 3.3 s, and it does not intercept clicks afterwards. It also dismisses under `prefers-reduced-motion`. The loading screen was caught on a client-side page switch. 0 console errors, 0 sideways overflow on 11 pages × 2 sizes, typecheck clean, 27/27 tests.
- 2026-10-05 — **UI restyled again to a second reference image** (a dark analytics dashboard: KPI card row, line chart, donut with value list, orange histogram, ranked table, world map). Frontend plus one new read-only API route; 0 Dune credits.
  - **Darker theme** (`app/globals.css`): near-black navy (page `#0a0f1c`, cards `#121a2c`, sidebar `#0d1322`), thinner borders, dimmer backdrop glow. Series colours were re-validated on these surfaces: all pass.
  - **Dashboard order** now follows the reference (`app/page.tsx`):
    1. Six KPI cards (net flow, inflow, outflow, unique wallets, transfers, PancakeSwap volume), each with its **change versus the previous period of equal length**. The text carries the direction (▲/▼), never colour.
       - Net flow shows the previous period's value instead of a percentage, because a percentage change on a signed number misleads.
       - "All time" has no previous period, so no comparison is shown.
       - PancakeSwap says "No activity in previous period" when the window falls before swap data starts (2026-09-25).
    2. The main gradient area chart plus the cumulative net flow chart.
    3. Two donuts, **inflow by exchange** (blue shades) and **outflow by exchange** (orange shades), each with a value and percentage list, around a **transfers-by-hour-of-day histogram**: stacked IN (blue) / OUT (orange), UTC.
    4. Exchange cards, then recent activity next to a **Top wallets** table (top 8 by volume), then a PancakeSwap card.
  - **New API route** `GET /api/flows/hourly` (`hourlyActivity` in `packages/analytics`): exchange transfer counts by UTC hour, a plain DB query. The hour totals were checked against `/api/overview` (549 IN / 131 OUT for 30d: exact match). Documented in the README.
  - **Colour rules:** blue always means inflow and orange always means outflow, so the share donuts use blue or orange steps (both ramps validated as ordinal), never a new hue per exchange. Donut slices have a 2px gap and every slice is listed with its value. A donut is within the dataviz guidance (≤6 slices, numbers beside it).
  - **Not copied: the world map.** There is no geographic data, and it must not be invented.
  - **Gotcha (Next.js):** a value exported from a `'use client'` file (an object or array) arrives in a server component as a *reference*, not the real value. `RAMPS[kind].length` was `undefined` and the page crashed (the new `error.tsx` page showed). The chart colours now live in the plain module `lib/colors.ts`, which both server and client code import. Keep shared constants out of `'use client'` files.
  - **Checks:** typecheck is clean for the API and web, and 27/27 tests pass. Headless Edge: 11 pages × phone and desktop have no sideways overflow and 0 console errors. Hover tooltips work on both donuts, the histogram and both area charts. Screenshots reviewed.
- 2026-10-05 — **UI restyle to match the owner's reference image** (an "ArBitrage"-style crypto dashboard: navy/slate panels, cyan accents, a metric strip, a gradient area chart). Frontend only; 0 credits.
  - **Theme** (`app/globals.css`): navy palette (page `#151929`, cards `#242a42`, sidebar `#1b2033`) with soft cyan/blue backdrop glows, glossy cyan buttons (`.btn`), cyan-blue gradient for the active tab and menu item, zebra table rows with a cyan hover, and circular gradient icon badges (`.badge-icon`).
  - **Header** (`components/price-ticker.tsx`): a single strip of icon metrics: price, 24h change, 24h volume, market cap, then Live/CoinGecko. The sidebar gets a "BNB Chain · read-only monitor" card and a blue-gradient active row.
  - **Dashboard** (`app/page.tsx`): hero net flow + cumulative chart, 5 icon stat tiles, then a **main gradient area chart** (`FlowArea`: blue IN area + orange OUT area, white dot markers, crosshair tooltip) with legend chips showing totals and an "Export CSV" button. Below it are three exchange cards (`components/flow-bars.tsx`: `ExchangeCards`) and the recent activity / PancakeSwap row. Exchange and PancakeSwap pages got icons on their tiles.
  - **Colour checks:** the series colours (blue/orange/aqua) were re-validated on both navy surfaces (`#242a42`, `#1d2236`) with `validate_palette.js`: all pass (CVD ΔE 9.4). Cyan is UI chrome only, never a data series. Net flow is never coloured green or red (brief §10: no bullish/bearish reading). The price 24h change keeps its arrow and sign as well as colour.
  - **Deliberate deviation from the dataviz guidance:** the area gradient fills are stronger than the usual ~10% wash, to match the reference. The line and the dot markers carry the identity.
  - **Not copied from the reference:** the swirling backdrop image, a user profile / referral block, and the Logout / Top-up controls. This is a read-only monitor with no accounts.
  - **Checks:** typecheck is clean for the API and web. Headless Edge sweep: 11 pages × phone and desktop have 0 sideways overflow and 0 console errors. Hover tooltips work on both area charts, and the Custom popover and active menu item work. Screenshots reviewed.
- 2026-10-05 — **UI redesign** (owner: "improve the UI, make it more professional and amazing"). Frontend only; no API, data or Dune changes, 0 credits.
  - **Design system** (`app/globals.css`, `components/ui.tsx`, `components/icons.tsx`):
    - Deeper page background with a soft glow, rounded cards with depth, uppercase table headers, pill badges for IN/OUT/BUY/SELL, and a brand mark and nav icons in the sidebar.
    - The time range is now a segmented control (1H…All) with the custom UTC range in a "Custom" popover.
    - The filter bar has a primary "Apply" button. Pages have small "eyebrow" labels.
    - Cards and tiles fade in, respecting reduced-motion.
  - **Dashboard** (`app/page.tsx`):
    - A hero figure (net exchange flow, 56px) with an IN/OUT split bar, next to a new **cumulative net flow** chart (`CumulativeArea`).
    - Stat tiles now have trend lines (`Sparkline`).
    - A new per-exchange comparison (`components/flow-bars.tsx`: paired IN/OUT bars on one scale), the IN/OUT bar chart at 430px, and a PancakeSwap card with the last price and a buy/sell split.
  - **Other pages:** magnitude bars behind amounts in the wallet, flow and exchange tables. PancakeSwap has a buy/sell split card and a segmented version switch. A long wallet address no longer overflows on phones.
  - **Charts** follow the dataviz skill: validated colours (blue IN, orange OUT, aqua net; checked with `validate_palette.js` against the dark surface: all pass, CVD ΔE 9.4), bars ≤24px with a 4px rounded top, 2px lines, a 10% area wash, a crosshair and tooltips with line-keys, one series with no legend box, and numbers always shown beside colour.
  - **Stale text fixed:** the Flows/Swaps pages said "Export CSV (up to 10,000 rows)" (the cap was removed on 2026-10-03). The Status page described the old hourly sync.
  - **Gotchas:**
    - Never use `Intl` compact formatting in client components (hydration mismatch). Use `compactNum` in `lib/format.ts`. It had a trailing-zero bug (100K → "1K") that I caught with a quick test and fixed.
    - Table header "stickiness" applies inside the card's scroll box.
    - In dev mode the Next "N" button overlaps the bottom of the sidebar. It is dev-only.
  - **Checks:** typecheck is clean for the API and web, and 27/27 tests pass. Headless Edge with phone and desktop emulation: 11 pages × 2 sizes have no sideways overflow and 0 console errors. Interaction test: both chart tooltips work, the Custom popover opens, and the active menu item is highlighted. Screenshots reviewed.
  - **Not done:** there is no light theme (dark only), and the Flows, Swaps, Status and wallet-profile pages got the shared styling only. They were not individually redesigned.
- 2026-10-05 — Owner asked "everything is working?". It was not: the PC had been shut down after ~13:07 UTC on 2026-10-03, so Postgres, API, web and worker were all stopped, and the days 2026-10-03 and 2026-10-04 had not been synced.
  - Restarted Postgres with `pg_ctl` (automatic crash recovery worked; data intact: 5,714 transfers, 5,818 swaps, 1,233 wallets), then the API, web and worker as detached processes. No port conflicts.
  - The worker caught up both missed days by itself: transfers 2026-10-03 +8 (5 already stored), 2026-10-04 +12; swaps 2026-10-03 +241 (57 already stored), 2026-10-04 +169. 0 rejected, ~0.31 credits.
  - Checked: API health, price, all 9 pages return 200, and the dashboard shows "Data through 2026-10-05 00:00 UTC". The web server caches `/api/meta` for 60 s, so right after a sync the page can show a mid-sync value for up to a minute.
  - Lesson: after a PC restart nothing comes back by itself; the owner has not yet chosen auto-start or a server (see Next steps).
- 2026-10-03 — **UI upgrade + live DEOD price** (owner request: "improve UI more, add real-time price at top from CoinGecko, free").
  - **Price:** checked that CoinGecko lists DEOD (id `decentrawood`) by contract address on platform `binance-smart-chain`.
    - `apps/api/src/price.ts` and `GET /api/price`: the API fetches CoinGecko at most once per 60 s (shared cache, one request in flight at a time). If CoinGecko fails it serves the last good value (`stale: true`) for up to 10 min, then returns 503. No API key is needed.
    - Browser path: `apps/web/app/api-price/route.ts` is a proxy, and `components/price-ticker.tsx` polls it every 30 s, only while the tab is visible. The browser never calls CoinGecko or the API directly.
    - The header shows the price, 24h change (arrow + sign, not colour alone), 24h volume, market cap, a CoinGecko link, and a "Live / Delayed" label.
    - **Not on-chain data:** it is a market price. It is labelled as such in the footer, is never stored, and is separate from the Dune data. The README no longer says Dune is the only source.
  - **UI:** sticky header and sidebar; the current page is highlighted in the menu (`components/nav-links.tsx`); the mobile menu lists every page (it had 3 before); a "Data through" block in the sidebar on every page; a loading skeleton (`app/loading.tsx`); an error page with retry (`app/error.tsx`); stat cards with a coloured top accent; tables scroll sideways instead of stretching the page; sticky table headers; focus rings; max page width 1600px.
  - **Bug found and fixed:** Node and browsers format compact USD differently ("$10.8M" vs "$10.80M"), which caused a React hydration error in the ticker. The ticker now formats by hand. Any client component that shows `Intl` compact numbers will hit the same problem.
  - **Next.js note:** this version's `error.tsx` receives `retry`, not `reset` (see `node_modules/next/dist/docs`).
  - **Checks:** typecheck is clean for the API and the web app. Using headless Edge with proper phone emulation (puppeteer-core installed in the scratchpad, not in the project): 8 pages × (390px and 1440px) have no sideways overflow and 0 browser console errors. Screenshots were reviewed. 27/27 tests pass.
  - Caveat: plain `--window-size` in headless Edge has a minimum width and crops the screenshot, so use device emulation for phone checks.
- 2026-10-03 — Owner asked why BitMart isn't fetching. Cause: the BitMart address's last DEOD transfer was **2026-08-19**, so its 24h/7d/30d views are empty and the sync is fine.
  - Checked with a free public BSC node (`balanceOf` at the latest block). For all 3 exchanges, the on-chain balance equals stored IN − OUT exactly (BitMart 15,552,604.1483; MEXC 24,317,613.7570; Toobit 11,943,475.7613).
  - Owner said yes to a Dune search for other BitMart wallets. I did **not** run it: `verify/06_discover_exchange_addresses.sql` already covered all 29 Dune-labelled BitMart addresses on BNB over full history on 2026-10-02, and found only dust on the others. A rerun would cost credits and return the same answer. 0 credits spent.
  - Free checks instead: BitMart's DEOD activity fell from ~300 transfers/month (Jun 322, Jul 295) to 3 in Aug and 0 since 2026-08-19. The address nonce is 1,212,280, about the same as the "1.21M" noted in `config/deod.yaml` on 2026-10-02, so it is not sending much of anything else either (a rough comparison only).
  - Unknown: why BitMart stopped using this address for DEOD. If they moved to a new wallet, finding it needs a new approach, such as tracing where the last large OUT transfers went (e.g. 4,999,687 DEOD to `0x5fec…e242be` on 2026-07-27), not another label search.
- 2026-10-03 — Started worker, API and web as detached processes (owner said "start").
  - All 12 pages and the CSV export return 200, and the dashboard shows "Data through 2026-10-03 06:43 UTC".
  - The worker logged "no completed day to sync yet", as expected.
  - Replaced an orphaned API process left on :4000 from an earlier check.
  - Added `logs/` to `.gitignore`. Made the initial commit `49ad266` (79 files; checked: no `.env`, data files or secrets).
- 2026-10-03 — **Switched to completed-day sync** (owner: daily monitoring going forward, no historical backfill, don't keep re-fetching the incomplete day).
  - Added `completedDayWindows` and `utcDayStart` to `packages/core` with 5 tests; 27/27 pass.
  - Rewrote the worker sync (`apps/worker/src/sync.ts`, `index.ts`). The CLI `incremental` command became `daily`. Admin sync now returns `daysFetched`.
  - Added `dataThrough` and `freshnessNote` to `/api/meta` (`packages/analytics`, `apps/api`) and show them on the dashboard (`apps/web/app/page.tsx`, `lib/api.ts`).
  - Replaced `SYNC_OVERLAP_HOURS` with `SYNC_SETTLE_HOURS` in `.env.example`, and added a README "Daily sync" section.
  - Checks: typecheck and web typecheck clean. The daily dry run fetched 0 days and made no Dune call. The live API returned `dataThrough`. Swap CSV = 5,818 rows (complete). Admin without token = 401.
- 2026-10-03 — Ran the catch-up incremental sync (owner approved): +33 transfers, +367 swaps, 0 rejected, ~0.2 credits. The first attempt failed with `ECONNRESET` from a broken orphaned Postgres; I stopped and restarted it with `pg_ctl` (see the gotcha in §5). No credits were spent on the failed attempt.
- 2026-10-03 — Added `queries/dune/verify/07_swap_counts.sql` and ran it on Dune (2.6 credits): 92,486 swaps since 2026-01-01. Raw result in `.dune-output/07_swap_counts.json`.
- 2026-10-03 — Deleted the unused legacy `queries/dune/exchange_flows.sql` (owner approved).
- 2026-10-03 — Removed the 10,000-row cap on CSV exports. Flows, swaps and wallet activity CSVs now return every matching row (`CSV_MAX_ROWS` = 1,000,000), so a full swap backfill can't silently truncate exports. JSON endpoints are still paginated — `apps/api/src/server.ts`.
- 2026-10-03 — Checked the brief against the code and data. Tests, typecheck and web typecheck pass. Found the swap history only goes back to 2026-09-25 and the sync has been stopped since 2026-10-02 11:35 UTC. No Dune credits spent.
- 2026-10-03 — Saved the owner's original brief word for word; added the brief link and a table of deliberate differences to the handoff — `docs/ORIGINAL_BRIEF.md`, `HANDOFF.md` — so sessions on any account have the full spec.
- 2026-10-03 — Created `HANDOFF.md` and root `CLAUDE.md` (the rule to auto-maintain the handoff, independent of Claude account) — `HANDOFF.md`, `CLAUDE.md` — user request.
