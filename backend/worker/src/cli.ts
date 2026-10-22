// Manual sync commands:
//   npm run sync -- backfill [--query exchange_transfers|pancakeswap_swaps] --from 2026-01-01 [--to 2026-10-01] [--window-days 30]
//   npx tsx worker/src/cli.ts today   (the unfinished current UTC day so far; costs credits, 10 min cooldown)
//   npx tsx worker/src/cli.ts alerts [--rescan]   (scan stored data for alerts; database only, spends no credits)
//   npx tsx worker/src/cli.ts notify-test   (send one test message to Telegram)
//   npm run sync -- daily        (fetch every completed UTC day not yet synced; never the current day)
import { closePool, getPool, migrate, seedFromConfig } from '@deod/db';
import { scanAlerts } from './alerts/scan.js';
import { notifyPending, senderFromEnv } from './alerts/notify.js';
import { backfill, syncAllCompletedDays, syncToday, log, QUERIES, withSyncLock, type QueryName } from './sync.js';

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function parseDate(s: string | undefined, fallback?: Date): Date {
  if (!s) {
    if (fallback) return fallback;
    throw new Error('missing date');
  }
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid date: ${s}`);
  return d;
}

const cmd = process.argv[2];
try {
  await migrate(getPool());
  await seedFromConfig();
  if (cmd === 'backfill') {
    const from = parseDate(arg('from'));
    const to = parseDate(arg('to'), new Date());
    const windowDays = Number(arg('window-days') ?? 30);
    if (!(windowDays > 0)) throw new Error('--window-days must be > 0');
    const q = arg('query') as QueryName | undefined;
    if (q && !QUERIES.includes(q)) throw new Error(`unknown --query ${q}`);
    await withSyncLock(async () => {
      for (const name of q ? [q] : QUERIES) {
        const totals = await backfill(name, from, to, windowDays);
        log.info({ query: name, ...totals }, 'backfill complete');
      }
    });
  } else if (cmd === 'daily') {
    const days = await syncAllCompletedDays();
    log.info({ daysFetched: days }, days ? 'daily sync complete' : 'nothing to sync: no new completed day');
  } else if (cmd === 'alerts') {
    // Reads only the database: no Dune call, no credits. --rescan re-examines the last days; existing alerts are never duplicated.
    const r = await scanAlerts(getPool(), { rescan: process.argv.includes('--rescan') });
    log.info(r, 'alert scan complete');
    try { log.info(await notifyPending(), 'alert notifications'); }
    catch (e) { log.warn({ err: e instanceof Error ? e.message : String(e) }, 'alerts were scanned and stored; sending to Telegram failed'); }
  } else if (cmd === 'notify-test') {
    // Sends one clearly marked test message to Telegram so you can check the token and chat id. It stores nothing.
    const s = senderFromEnv();
    if (!s) throw new Error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are not set in backend/.env');
    await s.send('DEODScan test message: Telegram alerts are connected. No alert was triggered.');
    log.info('test message sent to Telegram');
  } else if (cmd === 'today') {
    const r = await syncToday();
    log.info(r, 'today so far fetched; the unfinished day is stored, the daily checkpoint is unchanged');
  } else {
    console.error('usage: sync alerts [--rescan] | sync notify-test | sync today | sync backfill --from YYYY-MM-DD [--to ...] [--window-days N] [--query name] | sync daily');
    process.exitCode = 2;
  }
} catch (err) {
  const e = err as Error & { code?: string; errors?: Error[] };
  // A refused database connection arrives as an AggregateError with an empty message; say what it means.
  const refused = e.code === 'ECONNREFUSED' || e.errors?.some((x) => (x as { code?: string }).code === 'ECONNREFUSED');
  log.error({ err: e.message || e.code || String(err) }, refused ? 'sync command failed: the database is not running. Start it first with npm run dev in another terminal' : 'sync command failed');
  process.exitCode = 1;
} finally {
  await closePool();
}
