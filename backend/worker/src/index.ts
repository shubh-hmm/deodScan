// Long-running worker: daily Dune sync. Each completed UTC day is fetched once, SYNC_SETTLE_HOURS after it ends.
// The worker wakes every SYNC_INTERVAL_MINUTES only to check whether a new day is ready; a check that finds
// nothing to fetch makes no Dune call and costs no credits.
//
// Shutdown (Ctrl+C, SIGTERM, Ctrl+Break, or a 'shutdown' message from `npm run dev`): no new day is started, and a sync that is
// already running gets up to SHUTDOWN_GRACE_SECONDS (default 20) to finish, so Dune credits already spent are not wasted.
import { closePool, getPool, migrate, seedFromConfig } from '@deod/db';
import { requestStop, syncAllCompletedDays, log } from './sync.js';

const intervalMs = Number(process.env.SYNC_INTERVAL_MINUTES ?? 60) * 60_000;
const graceMs = Number(process.env.SHUTDOWN_GRACE_SECONDS ?? 20) * 1000;
let running = false;
let inFlight: Promise<void> = Promise.resolve();
let timer: NodeJS.Timeout | undefined;
let stopping = false;

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

async function shutdown(reason: string) {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  requestStop();
  if (running) {
    log.info({ reason, graceSeconds: graceMs / 1000 }, 'shutdown requested; letting the running sync finish');
    const finished = await Promise.race([inFlight.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), graceMs))]);
    if (!finished) log.warn('the sync did not finish in time; exiting anyway. That day will be fetched again on the next start and may cost Dune credits again');
  } else {
    log.info({ reason }, 'shutdown requested');
  }
  await closePool();
  process.exit(0);
}

// Handlers go in before the first sync, so a shutdown during it is handled too.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.on(sig, () => void shutdown(sig));
process.on('message', (m) => { if (m === 'shutdown') void shutdown('asked by the parent process'); });

await migrate(getPool());
await seedFromConfig();
log.info({ checkIntervalMinutes: intervalMs / 60_000 }, 'worker started');
await tick();
if (!stopping) timer = setInterval(() => void tick(), intervalMs);
