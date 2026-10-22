// Manual sync commands:
//   npm run sync -- backfill [--query exchange_transfers|pancakeswap_swaps] --from 2026-01-01 [--to 2026-10-01] [--window-days 30]
//   npx tsx worker/src/cli.ts today   (the unfinished current UTC day so far; costs credits, 10 min cooldown)
//   npx tsx worker/src/cli.ts alerts [--rescan]   (scan stored data for alerts; database only, spends no credits)
//   npx tsx worker/src/cli.ts telegram-check   (check the bot token; sends nothing)
//   npx tsx worker/src/cli.ts telegram-users [--revoke <chat_id> | --restore <chat_id>]   (who is allowed in)
//   npm run sync -- daily        (fetch every completed UTC day not yet synced; never the current day)
import { closePool, getPool, migrate, seedFromConfig } from '@deod/db';
import { scanAlerts } from './alerts/scan.js';
import { apiFromEnv, notifyPending } from './alerts/notify.js';
import { MIN_ACCESS_CODE_LENGTH } from './telegram/bot.js';
import { loadEnv } from '@deod/config';
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
  } else if (cmd === 'telegram-check') {
    // Checks the bot token with Telegram (getMe). Sends no message and needs no database.
    const api = apiFromEnv();
    if (!api) throw new Error('TELEGRAM_BOT_TOKEN is not set in backend/.env');
    const me = await api.getMe();
    const code = loadEnv().TELEGRAM_ACCESS_CODE;
    log.info({ bot: `@${me.username}`, accessCode: code && code.length >= MIN_ACCESS_CODE_LENGTH ? 'set' : `NOT SET (needs ${MIN_ACCESS_CODE_LENGTH}+ characters): the bot stays off` },
      'Telegram token is valid. Open the bot, press Start and send the access code');
  } else if (cmd === 'telegram-users') {
    // Lists the people who started the bot. --revoke <chat_id> turns one away for good (the bot ignores them); --restore <chat_id> undoes it.
    const revoke = arg('revoke'), restore = arg('restore');
    if (revoke) await getPool().query(`UPDATE telegram_users SET status = 'blocked', subscribed_at = NULL, updated_at = now() WHERE chat_id = $1`, [revoke]);
    if (restore) await getPool().query(`UPDATE telegram_users SET status = 'new', failed_attempts = 0, locked_until = NULL, updated_at = now() WHERE chat_id = $1 AND status = 'blocked'`, [restore]);
    const { rows } = await getPool().query(`SELECT chat_id::text AS chat_id, username, first_name, status, authorized_at, subscribed_at FROM telegram_users ORDER BY created_at`);
    console.table(rows.map((r) => ({ chat_id: r.chat_id, username: r.username ?? '', name: r.first_name ?? '', status: r.status, allowed: r.authorized_at?.toISOString().slice(0, 16) ?? '', alerts_since: r.subscribed_at?.toISOString().slice(0, 16) ?? '' })));
  } else if (cmd === 'today') {
    const r = await syncToday();
    log.info(r, 'today so far fetched; the unfinished day is stored, the daily checkpoint is unchanged');
  } else {
    console.error('usage: sync alerts [--rescan] | sync telegram-check | sync telegram-users [--revoke <chat_id>] | sync today | sync backfill --from YYYY-MM-DD [--to ...] [--window-days N] [--query name] | sync daily');
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
