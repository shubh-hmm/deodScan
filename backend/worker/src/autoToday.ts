// Automatic "today so far" updates: the worker fetches today's unfinished UTC day at fixed times (by default twice a day), so the dashboard
// does not depend on someone pressing "Update today". It uses the SAME daily budget as the button (REFRESH_TODAY_MAX_PER_DAY, default 2),
// so the Dune cost stays capped: automatic and manual updates together never exceed it.
//
// Rule, checked every minute by the worker: take the most recent scheduled time that has passed today (UTC). If nothing has fetched today's
// data since then, the budget is not used up and the minimum gap since the last update has passed, run one update. A manual press after that
// time counts as the update for that slot. A slot the worker missed (it was off) is not made up later except for the most recent one.
import type pg from 'pg';
import { getPool } from '@deod/db';
import { QUERIES, SyncBusyError, SyncCooldownError, SyncLimitError, log, syncToday, todayCooldownSeconds, todayUsage } from './sync.js';

export interface Slot { hour: number; minute: number }

export const DEFAULT_TIMES = '06:00,14:00';

/** "06:00,14:00" -> slots (UTC). Anything malformed makes the whole value invalid (null) so the caller can fall back and say so. */
export function parseTimes(text: string | undefined): Slot[] | null {
  const parts = (text ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length || parts.length > 6) return null;
  const slots: Slot[] = [];
  for (const p of parts) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(p);
    if (!m) return null;
    const hour = Number(m[1]), minute = Number(m[2]);
    if (hour > 23 || minute > 59) return null;
    slots.push({ hour, minute });
  }
  return slots.sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));
}

export interface AutoConfig { enabled: boolean; slots: Slot[]; warning: string | null }

/** From the environment: AUTO_UPDATE_TODAY (default true) and AUTO_UPDATE_TODAY_AT (UTC times, default 06:00,14:00). */
export function autoConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AutoConfig {
  const enabled = (env.AUTO_UPDATE_TODAY ?? 'true').toLowerCase() !== 'false';
  const parsed = parseTimes(env.AUTO_UPDATE_TODAY_AT || DEFAULT_TIMES);
  if (parsed) return { enabled, slots: parsed, warning: null };
  return { enabled, slots: parseTimes(DEFAULT_TIMES)!, warning: `AUTO_UPDATE_TODAY_AT ("${env.AUTO_UPDATE_TODAY_AT}") is not a list of HH:MM times in UTC such as 06:00,14:00; using ${DEFAULT_TIMES}` };
}

/** The most recent scheduled time at or before `now` on the same UTC day, or null when none has come yet today. */
export function latestSlot(now: Date, slots: Slot[]): Date | null {
  let best: Date | null = null;
  for (const s of slots) {
    const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), s.hour, s.minute));
    if (t <= now && (!best || t > best)) best = t;
  }
  return best;
}

export interface AutoResult { ran: boolean; reason: string }

/** One check. `run` is the update itself (syncToday), replaceable for tests. Never throws for an expected refusal. */
export async function autoUpdateCheck(
  now = new Date(), cfg: AutoConfig = autoConfigFromEnv(), db: pg.Pool = getPool(), run: (now: Date) => Promise<unknown> = syncToday,
): Promise<AutoResult> {
  if (!cfg.enabled) return { ran: false, reason: 'automatic updates are switched off (AUTO_UPDATE_TODAY=false)' };
  const slot = latestSlot(now, cfg.slots);
  if (!slot) return { ran: false, reason: 'no scheduled time has come yet today' };
  const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM sync_runs WHERE mode = 'today' AND query_name = $1 AND started_at >= $2`, [QUERIES[0], slot]);
  if ((rows[0]?.n ?? 0) > 0) return { ran: false, reason: `today's data was already updated since ${slot.toISOString().slice(11, 16)} UTC` };
  const usage = await todayUsage(now, db);
  if (usage.remaining <= 0) return { ran: false, reason: `the daily limit of ${usage.max} updates is used up` };
  const wait = await todayCooldownSeconds(now, db);
  if (wait > 0) return { ran: false, reason: `the last update was too recent (try again in ${Math.ceil(wait / 60)} min)` };
  try {
    await run(now);
    return { ran: true, reason: `updated for the ${slot.toISOString().slice(11, 16)} UTC slot` };
  } catch (e) {
    if (e instanceof SyncBusyError) return { ran: false, reason: 'another sync is running; will try again in a minute' };
    if (e instanceof SyncLimitError || e instanceof SyncCooldownError) return { ran: false, reason: e.message };
    throw e;
  }
}

/** The worker's loop: checks once a minute. Returns a stop function and a promise for any update still running. */
export function startAutoUpdates(cfg: AutoConfig = autoConfigFromEnv()) {
  if (cfg.warning) log.warn({}, cfg.warning);
  let busy = false;
  let current: Promise<void> = Promise.resolve();
  let stopped = false;
  const check = () => {
    if (stopped || busy || !cfg.enabled) return;
    busy = true;
    current = (async () => {
      try {
        const r = await autoUpdateCheck(new Date(), cfg);
        if (r.ran) log.info({ reason: r.reason }, 'automatic update of today so far done');
      } catch (err) {
        log.error({ err: err instanceof Error ? err.message : String(err) }, 'automatic update of today so far failed; it counts as one of the day\'s updates and is not retried until the next scheduled time');
      } finally {
        busy = false;
      }
    })();
  };
  if (cfg.enabled) log.info({ timesUtc: cfg.slots.map((s) => `${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}`) }, 'automatic updates of today so far are on');
  const timer = setInterval(check, 60_000);
  setTimeout(check, 5_000).unref();                       // soon after start, in case a scheduled time was missed while the worker was off
  return { stop() { stopped = true; clearInterval(timer); }, running: () => busy, done: () => current };
}
