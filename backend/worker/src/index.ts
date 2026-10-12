// Long-running worker: daily Dune sync. Each completed UTC day is fetched once, SYNC_SETTLE_HOURS after it ends.
// The worker wakes every SYNC_INTERVAL_MINUTES only to check whether a new day is ready; a check that finds
// nothing to fetch makes no Dune call and costs no credits.
import { closePool, getPool, migrate, seedFromConfig } from '@deod/db';
import { syncAllCompletedDays, log } from './sync.js';

const intervalMs = Number(process.env.SYNC_INTERVAL_MINUTES ?? 60) * 60_000;
let running = false;
let timer: NodeJS.Timeout;

async function tick() {
  if (running) return log.warn('previous sync still running; skipping tick');
  running = true;
  try {
    const days = await syncAllCompletedDays();
    if (days) log.info({ daysFetched: days }, 'daily sync complete');
  } catch (err) {
    log.error({ err: (err as Error).message }, 'daily sync failed; will retry next check');
  } finally {
    running = false;
  }
}

await migrate(getPool());
await seedFromConfig();
log.info({ checkIntervalMinutes: intervalMs / 60_000 }, 'worker started');
await tick();
timer = setInterval(tick, intervalMs);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    clearInterval(timer);
    await closePool();
    process.exit(0);
  });
}
