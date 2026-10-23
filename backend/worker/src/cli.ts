// Manual sync commands:
//   npm run sync -- backfill [--query exchange_transfers|pancakeswap_swaps] --from 2026-01-01 [--to 2026-10-01] [--window-days 30]
//   npx tsx worker/src/cli.ts today   (the unfinished current UTC day so far; costs credits, 10 min cooldown)
//   npx tsx worker/src/cli.ts alerts [--rescan]   (scan stored data for alerts; database only, spends no credits)
//   npx tsx worker/src/cli.ts telegram-check   (check the bot token; sends nothing)
//   npx tsx worker/src/cli.ts ask-check [--question "..."]   (check the OpenAI key and model; --question asks one real question and spends a few cents)
//   npx tsx worker/src/cli.ts telegram-test   (one TEST message to everyone subscribed; not an alert)
//   npx tsx worker/src/cli.ts telegram-users [--revoke <chat_id> | --restore <chat_id>]   (who is allowed in)
//   npm run sync -- daily        (fetch every completed UTC day not yet synced; never the current day)
import { closeDb, getDb, migrate, seedFromConfig } from '@deod/db';
import { scanAlerts } from './alerts/scan.js';
import { apiFromEnv, notifyPending } from './alerts/notify.js';
import { autoConfigFromEnv, autoUpdateCheck } from './autoToday.js';
import { MIN_ACCESS_CODE_LENGTH } from './telegram/bot.js';
import { loadEnv } from '@deod/config';
import { createAsk, listModels } from '@deod/ask';
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
  await migrate(getDb());
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
    const r = await scanAlerts(getDb(), { rescan: process.argv.includes('--rescan') });
    log.info(r, 'alert scan complete');
    try { log.info(await notifyPending(), 'alert notifications'); }
    catch (e) { log.warn({ err: e instanceof Error ? e.message : String(e) }, 'alerts were scanned and stored; sending to Telegram failed'); }
  } else if (cmd === 'auto-check') {
    // Shows what the worker's automatic update of today's data would do right now. A dry run: nothing is fetched and no credits are spent
    // unless you add --run (which then performs the update if it is due).
    const cfg = autoConfigFromEnv();
    const real = process.argv.includes('--run');
    const r = await autoUpdateCheck(new Date(), cfg, getDb(), real ? (n: Date) => syncToday(n, 'auto') : async () => undefined);
    log.info({ enabled: cfg.enabled, timesUtc: cfg.slots.map((s) => `${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}`), warning: cfg.warning }, 'automatic update settings');
    console.log(r.ran ? (real ? `Updated now: ${r.reason}` : `Dry run: an update is DUE now (${r.reason}). Add --run to perform it (spends Dune credits).`) : `Nothing to do now: ${r.reason}`);
  } else if (cmd === 'ask-check') {
    // Checks "Ask DEODScan AI": the OpenAI key, whether the chosen model is available to it, and (only with --question "...") one real question,
    // which uses a few cents of OpenAI credit. Without --question nothing is spent.
    const env = loadEnv();
    if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set in backend/.env');
    const models = await listModels(env.OPENAI_API_KEY);
    const ok = models.includes(env.OPENAI_MODEL);
    log.info({ model: env.OPENAI_MODEL, available: ok, dailyLimit: env.ASK_DAILY_LIMIT }, ok ? 'OpenAI key works and the model is available' : 'OpenAI key works, but OPENAI_MODEL is not available to it: set OPENAI_MODEL to one of the models below');
    if (!ok) console.log(models.filter((m) => /^(gpt|o\d|chatgpt)/.test(m)).join('\n'));
    const question = arg('question');
    if (ok && question) {
      const r = await createAsk(getDb()).ask(question);
      console.log(`\nAnswer (${r.verified ? 'every figure checked against your data' : 'WITHHELD: a figure could not be checked'}):\n${r.answer}`);
      console.log(`\nTools used: ${r.data.map((d) => `${d.tool}${d.error ? ' (error)' : ''}`).join(', ') || 'none'}`);
      log.info({ ...r.usage, remainingToday: r.remainingToday }, 'tokens used');
    }
  } else if (cmd === 'telegram-check') {
    // Checks the bot token with Telegram (getMe). Sends no message and needs no database.
    const api = apiFromEnv();
    if (!api) throw new Error('TELEGRAM_BOT_TOKEN is not set in backend/.env');
    const me = await api.getMe();
    const code = loadEnv().TELEGRAM_ACCESS_CODE;
    log.info({ bot: `@${me.username}`, accessCode: code && code.length >= MIN_ACCESS_CODE_LENGTH ? 'set' : `NOT SET (needs ${MIN_ACCESS_CODE_LENGTH}+ characters): the bot stays off` },
      'Telegram token is valid. Open the bot, press Start and send the access code');
  } else if (cmd === 'telegram-test') {
    // Sends one clearly marked TEST message to everyone who is subscribed. It is not an alert: nothing is stored and no alert is created.
    const api = apiFromEnv();
    if (!api) throw new Error('TELEGRAM_BOT_TOKEN is not set in backend/.env');
    const rows = await getDb().collection('telegram_users').find({ status: 'subscribed' }).toArray();
    for (const r of rows) await api.sendMessage(String(r._id), 'TEST from DEODScan: alert delivery works. This is only a test, no real alert was triggered.');
    log.info({ recipients: rows.length }, 'test message sent');
  } else if (cmd === 'telegram-users') {
    // Lists the people who started the bot. --revoke <chat_id> turns one away for good (the bot ignores them); --restore <chat_id> undoes it.
    const revoke = arg('revoke'), restore = arg('restore');
    const users = getDb().collection('telegram_users');
    if (revoke) await users.updateOne({ _id: Number(revoke) as never }, { $set: { status: 'blocked', subscribed_at: null, updated_at: new Date() } });
    if (restore) await users.updateOne({ _id: Number(restore) as never, status: 'blocked' }, { $set: { status: 'new', failed_attempts: 0, locked_until: null, updated_at: new Date() } });
    const rows = await users.find().sort({ created_at: 1 }).toArray();
    console.table(rows.map((r) => ({ chat_id: String(r._id), username: r.username ?? '', name: r.first_name ?? '', status: r.status, allowed: r.authorized_at?.toISOString().slice(0, 16) ?? '', alerts_since: r.subscribed_at?.toISOString().slice(0, 16) ?? '' })));
  } else if (cmd === 'today') {
    const r = await syncToday();
    log.info(r, 'today so far fetched; the unfinished day is stored, the daily checkpoint is unchanged');
  } else {
    console.error('usage: sync alerts [--rescan] | sync telegram-test | sync telegram-check | sync auto-check [--run] | sync ask-check [--question "..."] | sync telegram-users [--revoke <chat_id>] | sync today | sync backfill --from YYYY-MM-DD [--to ...] [--window-days N] [--query name] | sync daily');
    process.exitCode = 2;
  }
} catch (err) {
  const e = err as Error & { code?: string; errors?: Error[] };
  // A database that cannot be reached shows up as a server-selection error (MongoDB) or a refused connection; say what it means.
  const refused = e.name === 'MongoServerSelectionError' || e.code === 'ECONNREFUSED' || e.errors?.some((x) => (x as { code?: string }).code === 'ECONNREFUSED');
  log.error({ err: e.message || e.code || String(err) }, refused ? 'sync command failed: the database is not running. Start it first with npm run dev in another terminal' : 'sync command failed');
  process.exitCode = 1;
} finally {
  await closeDb();
}
