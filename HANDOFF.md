# HANDOFF — DEOD On-Chain Monitor

> **Standing rule for every Claude session (any account / Claude ID):**
> You are responsible for keeping this file current, automatically, without the user asking.
> The user may switch Claude accounts at any time and will NOT remind you. Read this file at the
> start of every session, and update it (Work log + Current state + Next steps) whenever you change
> code, config, queries, data, or decisions. Do not wait until the end of the session. Short entries
> are fine; skipping them is not.

Last updated: 2026-10-03

---

## 1. What this project is

A read-only dashboard tracking DEOD token movement on **BNB Chain only**:
- DEOD flowing into/out of monitored **MEXC**, **BitMart**, **Toobit** addresses
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

## 2. Repo map

| Path | What it is |
|---|---|
| `config/deod.yaml` | All verified addresses (token, pools, exchanges) + how each was checked |
| `packages/config` | Loads/validates `deod.yaml` |
| `packages/core` | Shared domain logic (+ `test/core.test.ts`) |
| `packages/db` | Postgres client, migrations (`001_init.sql`, `002_backfill_cursor.sql`) |
| `packages/dune` | Dune API client (`POST /v1/sql/execute`) |
| `packages/analytics` | Aggregation queries used by the API |
| `apps/worker` | Sync loop (`index.ts`), sync logic (`sync.ts`), backfill CLI (`cli.ts`) |
| `apps/api` | Fastify server (`server.ts`), CSV export (`csv.ts`) |
| `apps/web` | Next.js dashboard (overview, flows, swaps, wallets, wallet/[address], [venue], search, status) |
| `queries/dune/` | Production SQL (`exchange_transfers.sql`, `pancakeswap_swaps.sql`); `verify/` = one-off checks |
| `scripts/` | `dev-postgres.mjs` (local PG on :5433), `dune-run.mjs` (run a query file against Dune) |

Note: `queries/dune/exchange_flows.sql` exists but the README lists only the two queries above, so it may be a leftover. Check before relying on it.

## 3. Key decisions & verified facts (do not re-litigate)

- **BNB Chain only.** Never discover or monitor other chains; filter `blockchain='bnb'` first.
- **The V2 and V3 pool labels in the original brief were swapped.** `config/deod.yaml` and the README have the corrected labels.
- **Toobit address** `0xb0b1…aa77` is labelled "Cobo 4" by Dune (a custody provider). The owner decided it counts as Toobit.
- Other Dune-labelled MEXC/BitMart/Cobo addresses each only ever received 5–15 DEOD, so they are listed in the config but not monitored.
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
- **Running on the owner's PC (since 2026-10-03 ~07:30 UTC), as detached hidden processes:**
  - Postgres on :5433, started with `pg_ctl`.
  - Worker, which checks hourly.
  - API on :4000 and web on :3000; open http://localhost:3000.
  - Logs: `logs/worker.log`, `logs/api.log`, `logs/web.log` (git-ignored).
  - These **do not survive a reboot**. To start again: run the `pg_ctl ... start` line from the gotcha below, then for each of `worker`, `api`, `web`, in PowerShell:
    `Start-Process cmd.exe -ArgumentList "/c npm run <name> > logs\<name>.log 2>&1" -WorkingDirectory G:\Monitor -WindowStyle Hidden`
  - To stop: find the PID with `Get-NetTCPConnection -LocalPort 4000` (or 3000) and run `Stop-Process`. For the worker, stop the `node` process whose command line includes `apps/worker/src/index.ts`.
  - Gotcha: if a port is already taken, the new process logs `EADDRINUSE` and exits while the old process keeps serving. Check the logs after a restart.
- Checks (2026-10-03): `npm test` passes (22/22). `npm run typecheck` is clean. The web app (`apps/web`, which the root typecheck does not cover) is also clean with `npx tsc --noEmit`.
- Local DB (`npm run db:dev`, data in `.pgdata/`), counted 2026-10-03:
  - **Sync model (owner decision 2026-10-03): daily, going forward. No historical swap backfill.**
  - Each completed UTC day is fetched once, as a whole [00:00, 24:00) window, `SYNC_SETTLE_HOURS` (default 2) after it ends. The current day is never fetched.
  - The worker checks hourly; a check with no new day makes no Dune call.
  - Code: `completedDayWindows` in `packages/core`, `syncCompletedDays` / `syncAllCompletedDays` in `apps/worker/src/sync.ts`. CLI: `npm run sync -- daily`. `POST /api/admin/sync` runs the same.
  - The old intraday `incremental` sync and `SYNC_OVERLAP_HOURS` were removed.
  - The dashboard shows "Data through …" (`/api/meta` `dataThrough` = min `synced_until`).
  - The first daily fetch will be all of 2026-10-03, after 2026-10-04 02:00 UTC. That day was partly loaded up to 06:44 by the catch-up sync; already-stored rows are skipped.
- `token_transfers`: 5,681 rows, 2026-01-09 → 2026-10-02 08:47. Full history from the 2026-01-01 backfill.
  - `exchange_flows`: MEXC 2,337 IN / 1,312 OUT · BitMart 442 / 610 · Toobit 715 / 265.
  - `dex_swaps`: **only 2026-09-25 → 2026-10-02.** V2 has 995 rows, V3 has 4,456. The swap backfill started at 2026-09-25, not 2026-01-01.
  - `ingest_rejections` 0, `wallet_summary` 1,203.
  - Dune credits spent: about 22.3 on transfers and 1.6 on swaps, plus 2.6 on the 2026-10-03 swap-count check.
  - After the 2026-10-03 catch-up sync, data runs to **2026-10-03 06:44 UTC** (+33 transfers, +367 swaps). The worker is not left running.
- **Swap volume in Dune** (from `verify/07_swap_counts.sql`, 2026-01-01 → 2026-10-03): **92,486 swaps**.
  - V3 has swaps from 2026-01-14 onward. V2 only from **2026-05-19**, when that pool was created.
  - Peak month: Aug 2026, with 15.2k V2 swaps.
  - Backfilling 2026-01-01 → 2026-09-25 means about **87k rows ≈ 230 credits** (at ~2.6 credits per 1k rows).

### Local Postgres gotcha
`npm run db:dev` runs Postgres as a child of a node wrapper. If the wrapper is killed (for example by a tool's background time limit), Postgres keeps running in a broken state: connections get `ECONNRESET`, and a restart fails with "postmaster.pid already exists". To fix it:
```
node_modules/@embedded-postgres/windows-x64/native/bin/pg_ctl.exe -D ./.pgdata stop -m fast
node_modules/@embedded-postgres/windows-x64/native/bin/pg_ctl.exe -D ./.pgdata -o "-p 5433" -l ./.pgdata/server.log -w start
```
Starting with `pg_ctl` directly, as in the second line, runs the server detached and avoids the problem.

## 6. Next steps / open items

- [x] ~~Swap backfill 2026-01-01 → 2026-09-25~~: the owner declined on 2026-10-03; only daily monitoring going forward is needed. Swap history starts 2026-09-25. Don't re-propose this unless asked.
- [x] Worker running on the owner's PC (2026-10-03). It only syncs while the PC is on and the processes are up.
- [ ] For always-on monitoring: move to a server (VPS + `docker-compose.yml` Postgres) or set the processes to start on Windows startup. Waiting on the owner's choice.
- [ ] After 2026-10-04 02:00 UTC: run or confirm the first daily sync of 2026-10-03, and check `sync_runs` shows mode `daily` with 0 rejected rows.
- [ ] Optional: the 1h/6h/24h ranges count back from the current time, so with daily data they show little or nothing for today. The owner may want them to count back from "data through" instead.
- [ ] Make the initial git commit (only when the user asks).

## 7. Work log (newest first)

Format: `YYYY-MM-DD — what changed — files — why/notes`

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
