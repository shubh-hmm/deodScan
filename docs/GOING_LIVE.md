# Going live: checklist for DEODScan

Read this before putting DEODScan on a server that anyone can reach. Everything below was checked against a copy of the real data (see HANDOFF.md,
log of 2026-10-22, "Platform robustness pass"). Items marked **must** can cost money or expose data if skipped.

## 1. What runs where

| Part | What it is | Needs to stay on? | Notes |
|---|---|---|---|
| Database | PostgreSQL | Yes | Use a managed database (Neon, Supabase, Railway, RDS...) or your own server. Not the embedded development one. |
| API | `backend/api` (Fastify) | Yes | Also reads the Telegram bot's messages, so it must be a normal always-on process, not a serverless function. Run **one** copy per bot. |
| Worker | `backend/worker` | Yes | Fetches each finished day from Dune once. Only this process (and the "Update today" button) spends Dune credits. |
| Dashboard | `frontend` (Next.js) | Yes | Vercel works for this part alone. |

## 2. Settings (must)

Backend (`backend/.env` on the server, never in git):

| Setting | Why |
|---|---|
| `DATABASE_URL` | the production database |
| `DUNE_API_KEY` | the worker; **`DUNE_MAX_CREDITS_PER_RUN`** (default 30) and **`DUNE_MAX_RUN_MINUTES`** (default 10) stop and cancel a runaway query |
| `INTERNAL_API_KEY` | **must**: a long random string. The API refuses to start on a non-local `API_HOST` without it. Put the same value in the dashboard's settings |
| `API_HOST` | `127.0.0.1` when the dashboard is on the same machine; otherwise the private address, and keep the port closed to the internet |
| `ADMIN_TOKEN` | only if you use `/api/admin/*`; long and random |
| `REFRESH_TODAY_ENABLED` | `true` keeps the "Update today" button (about 0.4 to 0.9 Dune credits per use) |
| `REFRESH_TODAY_MAX_PER_DAY` | uses of "Update today" per UTC day (default 2); `REFRESH_TODAY_COOLDOWN_MINUTES` (default 10) is the minimum gap between two uses |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ACCESS_CODE` | optional; the code is a long secret you give only to people you want in |
| `OPENAI_API_KEY`, `OPENAI_MODEL`, `ASK_DAILY_LIMIT` | optional; **also set a monthly spending limit in the OpenAI dashboard** |

Dashboard (`frontend/.env.local` or the host's settings):

| Setting | Why |
|---|---|
| `ADMIN_PASSWORD` | **must**: long passphrase. Without it nobody can sign in |
| `AUTH_SECRET` | **must**: 32+ random characters (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) |
| `API_BASE_URL` | where the dashboard server reaches the API |
| `INTERNAL_API_KEY` | the same value as in the backend |

## 3. Network and HTTPS (must)

- Serve the dashboard over **HTTPS only**. The sign-in cookie is marked Secure when the request arrives over HTTPS, and the dashboard sends HSTS.
- The **API must not be reachable from the internet**. Only the dashboard server talks to it. `INTERNAL_API_KEY` is the second lock if the address ever leaks.
- The database must not be reachable from the internet either (allow only the API and worker).
- The dashboard sends `X-Frame-Options: DENY`, `nosniff`, a strict referrer policy and a permissions policy on every page.

## 4. Keep the processes alive

The API and worker exit with an error after an unexpected crash on purpose, so that a process manager starts a fresh copy. Use one:

- **pm2:** `pm2 start "npx tsx api/src/server.ts" --name deod-api --cwd backend` and the same for `worker/src/index.ts`; then `pm2 save` and `pm2 startup`.
- **systemd / Docker / the host's own restart policy** work equally well: set "restart on failure".

Start the database first, then the API, then the worker, then the dashboard.

## 5. Backups (must)

The data can be re-fetched from Dune, but it costs credits and the earlier history depends on the load dates. Back the database up:

- A managed database: switch on its automatic daily backups and point-in-time recovery.
- Your own server: a nightly `pg_dump --format=custom --file deod-$(date +%F).dump "$DATABASE_URL"`, kept for at least 14 days and copied off the machine.
- **Test a restore once** (`pg_restore --create --dbname=postgres deod-....dump` into a scratch server) before you need it.

## 6. Monitoring

- Point an uptime monitor at `GET /api/health` (on the API, not exposed publicly: use the monitor from the same private network, or check it from the dashboard host). It returns HTTP 500 when the database does not answer.
- The same response has `dataStale: true` when the synced data is older than 48 hours, which means the worker stopped or the Dune key stopped working: alert on that.
- The worker logs `dune window done` with the credits of every run. The `sync_runs` table has the same, and the Sync status page shows it.
- Sign-in failures, Telegram conflicts and Dune cancellations are logged with plain messages (search for `refusing`, `cancelled`, `another process`).

## 7. Cost controls already built in

| Control | Limit |
|---|---|
| Dune: one run | cancelled after 10 minutes or 30 credits (raise the settings above for a deliberate large history load) |
| Dune: normal operation | each finished day is fetched once; the current day only when someone presses "Update today": at most 2 uses per UTC day and 10 minutes apart |
| Dune: wide history loads | never run `backfill` over a long range without checking the cost first: a scan of 18 months cost 71 credits and returned nothing |
| OpenAI | `ASK_DAILY_LIMIT` questions per UTC day; 120 seconds per question; at most 8 model calls per question |
| Telegram | at most 20 alerts per person per run; failed sends retried 5 times |

## 8. If something goes wrong

| Symptom | Likely cause and fix |
|---|---|
| Pages show an error / "backend is not answering" | API down or `API_BASE_URL` / `INTERNAL_API_KEY` mismatch: check the API log and `GET /api/health` |
| Data looks old (`dataStale`) | the worker is not running, or Dune/the key failed: check the worker log; run `npx tsx worker/src/cli.ts daily` once |
| A Dune run was cancelled by the safeguard | read the message: it says whether it was time or cost; if the load is deliberate raise `DUNE_MAX_*`, otherwise check the query |
| Telegram bot silent | two copies of the API are running (log: "another process is already reading this bot's messages"), or the token changed |
| Cannot sign in | `ADMIN_PASSWORD` / `AUTH_SECRET` missing (the page says so), or 5 wrong passwords locked the address for 15 minutes (restart the dashboard to clear) |
| Migration error on start | the API stops with the failing file name: restore from backup and send the message to whoever maintains the code |

## 9. Hosting on Vercel: what to know

- The **dashboard** can run on Vercel. Two small in-memory features (the sign-in lockout counter and the "Update today" job state) are per server instance there, so the lockout is weaker; the length of the password is the real protection.
- The **API, worker and Telegram bot must run on an always-on host** (Railway, Render, Fly.io, a VPS), because they poll and run for minutes.
- The dashboard on Vercel must reach the API: give the API a private network address or a public one protected by `INTERNAL_API_KEY` **and** a firewall rule that allows only Vercel's egress, which on the free plan are not fixed addresses: prefer a host where the API and dashboard share a private network.
