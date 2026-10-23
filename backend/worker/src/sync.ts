import pino from 'pino';
import { Decimal128, type Db } from 'mongodb';
import { loadConfig, loadEnv, monitoredPools } from '@deod/config';
import { completedDayWindows, normalizeSwap, normalizeTransfer, type SwapContext } from '@deod/core';
import { DuneClient, duneTimestamp, loadQuery, renderSql } from '@deod/dune';
import {
  deriveExchangeFlows, getDb, insertSwaps, insertTransfers, monitoredExchangeAddresses, nextIds,
  recordRejections, refreshWalletSummary, toDec128OrNull, withLock,
} from '@deod/db';

import { scanAlerts } from './alerts/scan.js';
import { notifyPending } from './alerts/notify.js';
export { scanAlerts } from './alerts/scan.js';
export { startBotFromEnv, MIN_ACCESS_CODE_LENGTH } from './telegram/bot.js';
export { apiFromEnv } from './alerts/notify.js';
export { autoConfigFromEnv } from './autoToday.js';

export const log = pino({ level: process.env.LOG_LEVEL ?? 'info', base: { svc: 'worker' } });

export type QueryName = 'exchange_transfers' | 'pancakeswap_swaps';
export const QUERIES: QueryName[] = ['exchange_transfers', 'pancakeswap_swaps'];

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/**
 * A UTC day is fetched only once this long after it ends. Dune indexes BNB data with some delay and curated
 * tables (e.g. V2 vs V3 models) can refresh at different times, so waiting lets the day's last blocks land
 * before its single fetch.
 */
const SETTLE_MS = Number(process.env.SYNC_SETTLE_HOURS ?? 2) * HOUR;

/** 'today' = the owner pressed "Update today": the unfinished current day, fetched on demand. It never moves the synced_until checkpoint. */
/** 'today_auto' = the same, started by the worker's schedule (own budget, see autoToday.ts). */
export type SyncMode = 'backfill' | 'daily' | 'today' | 'today_auto';

let dune: DuneClient | undefined;
function client() {
  dune ??= new DuneClient(loadEnv().DUNE_API_KEY ?? '', log);
  return dune;
}

interface WindowResult { fetched: number; inserted: number; duplicate: number; rejected: number; credits: number | null; newest: string | null }

async function runWindow(name: QueryName, mode: SyncMode, start: Date, end: Date, startedAt = new Date()): Promise<WindowResult> {
  const db = getDb();
  const cfg = loadConfig();
  const runId = await nextIds(db, 'sync_runs');
  await db.collection('sync_runs').insertOne({
    _id: runId as never, query_name: name, mode, window_start: start, window_end: end, started_at: startedAt, finished_at: null, status: 'running',
    execution_id: null, rows_fetched: null, rows_inserted: null, rows_duplicate: null, rows_rejected: null, credits: null, error: null,
  });
  await db.collection('dune_sync_state').updateOne(
    { _id: name as never },
    { $set: { query_name: name, status: 'running', updated_at: new Date() }, $setOnInsert: { credits_total: Decimal128.fromString('0') } },
    { upsert: true },
  );
  const wlog = log.child({ query: name, mode, start: start.toISOString(), end: end.toISOString() });
  wlog.info('dune window start');

  try {
    const params: Record<string, string> = {
      token_address: cfg.token.address,
      start_time: duneTimestamp(start),
      end_time: duneTimestamp(end),
    };
    if (name === 'exchange_transfers') {
      const addrs = await monitoredExchangeAddresses(db);
      if (!addrs.length) throw new Error('no monitored exchange addresses');
      params.exchange_addresses = addrs.map((a) => a.address).join(',');
    } else {
      params.pool_addresses = monitoredPools(cfg).map((p) => p.address).join(',');
      params.quote_addresses = Object.values(cfg.quote_tokens).map((q) => q.address).join(',');
    }

    const result = await client().runSql(renderSql(loadQuery(name), params));
    const rejected: { reasons: string[]; raw: unknown }[] = [];
    let inserted = 0;
    let valid = 0;
    let newest: string | null = null;

    if (name === 'exchange_transfers') {
      const ok = [];
      for (const raw of result.rows) {
        const n = normalizeTransfer(raw);
        if (!n.ok) { rejected.push({ reasons: n.errors, raw }); continue; }
        ok.push(n.value);
      }
      valid = ok.length;
      inserted = await insertTransfers(ok, cfg.token.address, cfg.token.decimals, db);
      newest = ok.at(-1)?.blockTime ?? null;
    } else {
      const ctx: SwapContext = {
        deodAddress: cfg.token.address,
        deodDecimals: cfg.token.decimals,
        pools: new Map(monitoredPools(cfg).map((p) => {
          const quoteSymbol = p.token0 === cfg.token.symbol ? p.token1 : p.token0;
          const q = cfg.quote_tokens[quoteSymbol]!;
          return [p.address, { version: p.version, quoteAddress: q.address, quoteDecimals: q.decimals }];
        })),
      };
      const quote = new Map(Object.entries(cfg.quote_tokens).map(([symbol, q]) => [q.address, { decimals: q.decimals, usdPeg: q.usd_peg, symbol }]));
      const ok = [];
      for (const raw of result.rows) {
        const n = normalizeSwap(raw, ctx);
        if (!n.ok) { rejected.push({ reasons: n.errors, raw }); continue; }
        ok.push(n.value);
      }
      valid = ok.length;
      inserted = await insertSwaps(ok, { deodDecimals: cfg.token.decimals, quote }, db);
      newest = ok.at(-1)?.blockTime ?? null;
    }

    if (rejected.length) {
      wlog.warn({ rejected: rejected.length, sample: rejected[0]?.reasons }, 'rows rejected by validation');
      await recordRejections(name, result.executionId, rejected, db);
    }
    const duplicate = valid - inserted;
    if (duplicate > 0) wlog.info({ duplicate }, 'duplicate rows skipped');

    await db.collection('sync_runs').updateOne({ _id: runId as never }, {
      $set: {
        finished_at: new Date(), status: 'ok', execution_id: result.executionId, rows_fetched: result.rows.length, rows_inserted: inserted,
        rows_duplicate: duplicate, rows_rejected: rejected.length, credits: toDec128OrNull(result.creditsUsed),
      },
    });
    // synced_until only moves forward ($max), so a re-run of an old window never rewinds the checkpoint. 'today' updates never move it.
    const moveCheckpoint = mode !== 'today' && mode !== 'today_auto';
    const forward: Record<string, Date> = { ...(newest ? { last_block_time: new Date(newest) } : {}), ...(moveCheckpoint ? { synced_until: end } : {}) };
    await db.collection('dune_sync_state').updateOne({ _id: name as never }, {
      $set: { status: 'ok', error: null, last_successful_execution: result.executionId, last_sync_at: new Date(), updated_at: new Date() },
      ...(Object.keys(forward).length ? { $max: forward } : {}),
      ...(result.creditsUsed ? { $inc: { credits_total: toDec128OrNull(result.creditsUsed)! } } : {}),
    });
    wlog.info({ fetched: result.rows.length, inserted, duplicate, rejected: rejected.length, credits: result.creditsUsed }, 'dune window done');
    return { fetched: result.rows.length, inserted, duplicate, rejected: rejected.length, credits: result.creditsUsed, newest };
  } catch (err) {
    const message = err instanceof Error ? `${err.message}${'body' in err && err.body ? ' ' + JSON.stringify(err.body) : ''}` : String(err);
    wlog.error({ err: message }, 'dune window failed');
    await db.collection('sync_runs').updateOne({ _id: runId as never }, { $set: { finished_at: new Date(), status: 'error', error: message } });
    await db.collection('dune_sync_state').updateOne({ _id: name as never }, { $set: { status: 'error', error: message, updated_at: new Date() } });
    throw err;
  }
}

async function postProcess() {
  const flows = await deriveExchangeFlows();
  await refreshWalletSummary();
  log.info({ newExchangeFlows: flows }, 'derived exchange flows and refreshed wallet summary');
  // Alerts read only what is now in the database (no Dune, no network). A failure here must never fail or undo the sync.
  try {
    const a = await scanAlerts();
    log.info({ ...a }, 'alert scan complete');
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'alert scan failed; the sync itself is unaffected');
  }
  // Telegram delivery is separate and optional: detection above never depends on it.
  try {
    const n = await notifyPending();
    if (n.sent || n.failed || n.remaining) log.info({ ...n }, 'alert notifications');
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'sending alert notifications failed; the alerts are stored and will be retried');
  }
}

/**
 * Historical backfill in fixed windows. If a backfill with the same start was interrupted, it resumes
 * from the last completed window (backfill_cursor), so a crash at 70% continues from there.
 */
export async function backfill(name: QueryName, from: Date, to: Date, windowDays: number) {
  const db = getDb();
  const state = db.collection('dune_sync_state');
  await state.updateOne({ _id: name as never }, { $setOnInsert: { query_name: name, status: 'idle', credits_total: Decimal128.fromString('0'), updated_at: new Date() } }, { upsert: true });
  const prev = await state.findOne({ _id: name as never }) as { backfill_from?: Date | null; backfill_cursor?: Date | null } | null;
  const sameRun = prev?.backfill_from?.getTime() === from.getTime() && prev.backfill_cursor;
  let cursor = sameRun && prev!.backfill_cursor! > from && prev!.backfill_cursor! < to ? prev!.backfill_cursor! : from;
  if (cursor !== from) log.info({ query: name, resumeFrom: cursor.toISOString() }, 'resuming backfill from checkpoint');
  else await state.updateOne({ _id: name as never }, { $set: { backfill_from: from, backfill_cursor: from } });

  const totals = { fetched: 0, inserted: 0, duplicate: 0, rejected: 0, credits: 0 };
  while (cursor < to) {
    const end = new Date(Math.min(cursor.getTime() + windowDays * DAY, to.getTime()));
    const r = await runWindow(name, 'backfill', cursor, end);
    await state.updateOne({ _id: name as never }, { $set: { backfill_cursor: end } });
    totals.fetched += r.fetched; totals.inserted += r.inserted; totals.duplicate += r.duplicate;
    totals.rejected += r.rejected; totals.credits += r.credits ?? 0;
    cursor = end;
  }
  await postProcess();
  return totals;
}

/**
 * Daily sync: fetches each completed UTC day once, as a whole [00:00, 24:00) window, after SETTLE_MS.
 * The current, incomplete day is never fetched. Missed days are caught up one window per day and
 * synced_until advances after each, so an interruption resumes at the first unsynced day.
 * Requires a prior backfill to set the checkpoint.
 */
let stopRequested = false;
/** After this, no new day window is started; a window that is already running is allowed to finish. */
export function requestStop() { stopRequested = true; }

export async function syncCompletedDays(name: QueryName, now = new Date()) {
  const state = await getDb().collection('dune_sync_state').findOne({ _id: name as never }) as { synced_until?: Date | null } | null;
  const syncedUntil = state?.synced_until;
  if (!syncedUntil) throw new Error(`${name}: no checkpoint yet; run a backfill first`);
  const windows = completedDayWindows(syncedUntil, now, SETTLE_MS);
  if (!windows.length) log.info({ query: name, syncedUntil: syncedUntil.toISOString() }, 'no completed day to sync yet');
  const results = [];
  for (const w of windows) {
    if (stopRequested) { log.warn({ query: name }, 'stop requested; the remaining days will be fetched next time'); break; }
    results.push(await runWindow(name, 'daily', w.start, w.end));
  }
  return results;
}

/** Daily sync for every query. Returns the number of day windows fetched (0 means no Dune calls were made). */
export async function syncAllCompletedDays() {
  return withSyncLock(async () => {
    let windows = 0;
    for (const q of QUERIES) { if (stopRequested) break; windows += (await syncCompletedDays(q)).length; }
    if (windows) await postProcess();
    return windows;
  });
}

/** Minimum time between two "Update today" fetches, so the button cannot burn Dune credits by being clicked repeatedly. */
export const TODAY_COOLDOWN_SECONDS = Number(process.env.REFRESH_TODAY_COOLDOWN_MINUTES ?? 10) * 60;

/**
 * How many times "Update today" may be used per UTC day (each use costs Dune credits: about 0.4 to 1.4). Environment: REFRESH_TODAY_MAX_PER_DAY,
 * default 2. A use that started counts even if it failed, because a started Dune run is billed.
 */
export const TODAY_MAX_PER_DAY = (() => { const n = Math.floor(Number(process.env.REFRESH_TODAY_MAX_PER_DAY)); return Number.isFinite(n) && n >= 1 ? n : 2; })();

export interface TodayUsage { used: number; max: number; remaining: number }

export async function todayUsage(now = new Date(), db: Db = getDb()): Promise<TodayUsage> {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  // One use starts one run per query, so counting the first query's runs counts the uses.
  const used = await db.collection('sync_runs').countDocuments({ mode: 'today', query_name: QUERIES[0], started_at: { $gte: dayStart } });
  return { used, max: TODAY_MAX_PER_DAY, remaining: Math.max(0, TODAY_MAX_PER_DAY - used) };
}

export class SyncLimitError extends Error {
  constructor(readonly max: number) {
    super(`"Update today" has already been used ${max} ${max === 1 ? 'time' : 'times'} today, which is the limit. It resets at 00:00 UTC; finished days are still synced automatically.`);
  }
}

/** Seconds until "Update today" may run again (0 = now). Based on the last 'today' run recorded in the database. */
export async function todayCooldownSeconds(now = new Date(), db: Db = getDb()): Promise<number> {
  const latest = await db.collection('sync_runs').find({ mode: { $in: ['today', 'today_auto'] } }, { projection: { started_at: 1 } }).sort({ started_at: -1 }).limit(1).next();
  const last = (latest?.started_at as Date | undefined) ?? null;
  return last ? Math.max(0, Math.ceil(TODAY_COOLDOWN_SECONDS - (now.getTime() - last.getTime()) / 1000)) : 0;
}

export class SyncCooldownError extends Error {
  constructor(readonly retryAfterSeconds: number) { super(`"Update today" was used a moment ago; try again in ${Math.ceil(retryAfterSeconds / 60)} min`); }
}

/**
 * "Today so far": fetches 00:00 UTC today -> now for every query, on demand (a button or `sync today`). The rows are stored
 * with the normal duplicate protection, so tomorrow's daily sync re-fetching the same day adds nothing twice. synced_until is
 * not moved. Costs Dune credits each time, hence the cooldown.
 */
export async function syncToday(now = new Date(), source: 'manual' | 'auto' = 'manual') {
  return withSyncLock(async () => {
    // The button's daily budget applies to manual updates only; the worker's scheduled updates have their own (two slots a day).
    if (source === 'manual') {
      const usage = await todayUsage(now);
      if (usage.remaining <= 0) throw new SyncLimitError(usage.max);
    }
    const wait = await todayCooldownSeconds(now);
    if (wait > 0) throw new SyncCooldownError(wait);
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const end = new Date(Math.floor(now.getTime() / 1000) * 1000);
    if (end.getTime() - start.getTime() < 60_000) throw new Error('too early: the UTC day has just started, try again in a minute');
    const totals = { inserted: 0, credits: 0, from: start.toISOString(), to: end.toISOString() };
    for (const q of QUERIES) {
      const r = await runWindow(q, source === 'auto' ? 'today_auto' : 'today', start, end, now);
      totals.inserted += r.inserted; totals.credits += r.credits ?? 0;
    }
    await postProcess();
    return totals;
  });
}

export class SyncBusyError extends Error {}

/** Cluster-wide mutex (a lease document in the database) so the worker, CLI and admin API never sync concurrently. */
export async function withSyncLock<T>(fn: () => Promise<T>): Promise<T> {
  return withLock(getDb(), 'sync', () => new SyncBusyError('another sync is already running'), fn);
}
