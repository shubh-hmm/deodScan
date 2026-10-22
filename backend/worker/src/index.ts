// Long-running worker: daily Dune sync. Each completed UTC day is fetched once, SYNC_SETTLE_HOURS after it ends.
// The worker wakes every SYNC_INTERVAL_MINUTES only to check whether a new day is ready; a check that finds
// nothing to fetch makes no Dune call and costs no credits.
//
// Shutdown (Ctrl+C, SIGTERM, Ctrl+Break, or a 'shutdown' message from `npm run dev`): no new day is started, and a sync that is
// already running gets up to SHUTDOWN_GRACE_SECONDS (default 20) to finish, so Dune credits already spent are not wasted.
import { closePool, getPool, migrate, seedFromConfig } from '@deod/db';
import { requestStop, syncAllCompletedDays, log } from './sync.js';
import { startAutoUpdates } from './autoToday.js';

const intervalMs = Number(process.env.SYNC_INTERVAL_MINUTES ?? 60) * 60_000;
const graceMs = Number(process.env.SHUTDOWN_GRACE_SECONDS ?? 20) * 1000;
let running = false;
let inFlight: Promise<void> = Promise.resolve();
let timer: NodeJS.Timeout | undefined;
let stopping = false;
// Automatic updates of today's unfinished day at fixed UTC times (default 06:00 and 14:00), see autoToday.ts. Started once the worker is up.
let auto: ReturnType<typeof startAutoUpdates> | undefined;

function tick(): Promise<void> {
  if (running) {
    log.warn('previous sync still running; skipping tick');
    return inFlight;
  }
  running = true;
  inFlight = (async () => {
    try {
      const days = await syncAllCompletedDays();
      if (days) log.info({ daysFetched: days }, 'daily sync complete');
    } catch (err) {
      log.error({ err: (err as Error).message }, 'daily sync failed; will retry next check');
    } finally {
      running = false;
    }
  })();
  return inFlight;
}

async function shutdown(reason: string, exitCode = 0) {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  auto?.stop();
  requestStop();
  if (running || auto?.running()) {
    log.info({ reason, graceSeconds: graceMs / 1000 }, 'shutdown requested; letting the running sync finish');
    const finished = await Promise.race([Promise.all([inFlight, auto?.done()]).then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), graceMs))]);
    if (!finished) log.warn('the sync did not finish in time; exiting anyway. That day will be fetched again on the next start and may cost Dune credits again');
  } else {
    log.info({ reason }, 'shutdown requested');
  }
  await closePool();
  process.exit(exitCode);
}

// Handlers go in before the first sync, so a shutdown during it is handled too.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.on(sig, () => void shutdown(sig));
// A stray failed promise is logged and the worker carries on. An error nobody caught means the process may be in an unknown state: finish the
// running sync if it can, exit with an error, and let the process manager (pm2, systemd, Docker, the host) start a fresh worker.
process.on('unhandledRejection', (err) => log.error({ err: err instanceof Error ? err.message : String(err) }, 'unhandled promise rejection (ignored, the worker keeps running)'));
process.on('uncaughtException', (err) => {
  log.error({ err: err.message }, 'uncaught exception: shutting down so the process manager can restart the worker');
  setTimeout(() => process.exit(1), 30_000).unref();
  void shutdown('uncaught exception', 1);
});
process.on('message', (m) => { if (m === 'shutdown') void shutdown('asked by the parent process'); });

await migrate(getPool());
await seedFromConfig();
log.info({ checkIntervalMinutes: intervalMs / 60_000 }, 'worker started');
await tick();
if (!stopping) timer = setInterval(() => void tick(), intervalMs);
if (!stopping) auto = startAutoUpdates();
