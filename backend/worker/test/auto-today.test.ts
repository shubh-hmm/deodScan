// Automatic updates of today's data: when they are due, how they share the daily budget with the button, and that they never run twice for one
// time slot. The update itself is replaced by a stand-in, so nothing here calls Dune. Runs on a THROWAWAY database; skipped when none is reachable.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { loadEnv } from '@deod/config';
import { migrate } from '@deod/db';
import { SyncBusyError } from '../src/sync.js';
import { autoConfigFromEnv, autoUpdateCheck, latestSlot, parseTimes, type AutoConfig } from '../src/autoToday.js';

describe('the schedule setting', () => {
  it('reads times in UTC, in order', () => {
    expect(parseTimes('14:00, 06:00')).toEqual([{ hour: 6, minute: 0 }, { hour: 14, minute: 0 }]);
    expect(parseTimes('6:30')).toEqual([{ hour: 6, minute: 30 }]);
  });
  it('rejects anything that is not a list of HH:MM times', () => {
    for (const bad of ['', '25:00', '12:60', 'noon', '06:00;14:00', '1,2', '06:00,14:00,x', undefined]) expect(parseTimes(bad as string)).toBeNull();
    expect(parseTimes('01:00,02:00,03:00,04:00,05:00,06:00,07:00')).toBeNull();        // more than 6 a day is not "a couple of updates"
  });
  it('defaults to 06:00 and 14:00 UTC, on, and warns about a bad value instead of failing', () => {
    expect(autoConfigFromEnv({})).toMatchObject({ enabled: true, slots: [{ hour: 6, minute: 0 }, { hour: 14, minute: 0 }], warning: null });
    expect(autoConfigFromEnv({ AUTO_UPDATE_TODAY: 'false' }).enabled).toBe(false);
    const c = autoConfigFromEnv({ AUTO_UPDATE_TODAY_AT: 'whenever' });
    expect(c.slots).toHaveLength(2);
    expect(c.warning).toMatch(/AUTO_UPDATE_TODAY_AT/);
  });
  it('finds the most recent scheduled time that has passed today', () => {
    const slots = parseTimes('06:00,14:00')!;
    expect(latestSlot(new Date('2026-10-22T05:59:59Z'), slots)).toBeNull();
    expect(latestSlot(new Date('2026-10-22T06:00:00Z'), slots)!.toISOString()).toBe('2026-10-22T06:00:00.000Z');
    expect(latestSlot(new Date('2026-10-22T13:59:00Z'), slots)!.toISOString()).toBe('2026-10-22T06:00:00.000Z');
    expect(latestSlot(new Date('2026-10-22T23:59:00Z'), slots)!.toISOString()).toBe('2026-10-22T14:00:00.000Z');
    expect(latestSlot(new Date('2026-10-23T00:00:01Z'), slots)).toBeNull();            // a new UTC day starts without a slot
  });
});

let admin: pg.Client | null = null;
let baseUrl = '';
try {
  baseUrl = loadEnv().DATABASE_URL;
  admin = new pg.Client({ connectionString: baseUrl, connectionTimeoutMillis: 3000 });
  await admin.connect();
} catch {
  admin = null;
}

describe.skipIf(!admin)('when an automatic update is due', () => {
  const dbName = `deod_auto_test_${Date.now()}`;
  let pool: pg.Pool;
  const cfg: AutoConfig = { enabled: true, slots: parseTimes('06:00,14:00')!, warning: null };
  const record = async (at: string) => {                         // one update = one run per query
    for (const q of ['exchange_transfers', 'pancakeswap_swaps']) await pool.query(`INSERT INTO sync_runs (query_name, mode, window_start, window_end, started_at, status) VALUES ($1, 'today', $2, $2, $2, 'ok')`, [q, at]);
  };
  const clear = () => pool.query('DELETE FROM sync_runs');
  let calls: Date[] = [];
  const run = (at?: string) => async (now: Date) => { calls.push(now); if (at) await record(at); };
  const check = (when: string, opts: { cfg?: AutoConfig; run?: (n: Date) => Promise<unknown> } = {}) =>
    autoUpdateCheck(new Date(when), opts.cfg ?? cfg, pool, opts.run ?? run());

  beforeAll(async () => {
    await admin!.query(`CREATE DATABASE ${dbName}`);
    pool = new pg.Pool({ connectionString: baseUrl.replace(/\/[^/]*$/, `/${dbName}`), max: 3 });
    await migrate(pool);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  it('does nothing before the first scheduled time of the day', async () => {
    await clear(); calls = [];
    expect(await check('2026-10-22T05:30:00Z')).toMatchObject({ ran: false, reason: 'no scheduled time has come yet today' });
    expect(calls).toHaveLength(0);
  });

  it('runs once after a scheduled time, and not again for the same time however often it is checked', async () => {
    await clear(); calls = [];
    expect((await check('2026-10-22T06:00:30Z', { run: run('2026-10-22T06:00:30Z') })).ran).toBe(true);
    for (const t of ['2026-10-22T06:01:30Z', '2026-10-22T06:30:00Z', '2026-10-22T13:59:00Z']) {
      const r = await check(t);
      expect(r.ran).toBe(false);
      expect(r.reason).toMatch(/already updated since 06:00 UTC/);
    }
    expect(calls).toHaveLength(1);
  });

  it('runs again at the second scheduled time, then stops: two a day in all', async () => {
    await clear(); calls = [];
    await check('2026-10-22T06:00:30Z', { run: run('2026-10-22T06:00:30Z') });
    expect((await check('2026-10-22T14:00:30Z', { run: run('2026-10-22T14:00:30Z') })).ran).toBe(true);
    for (const t of ['2026-10-22T14:01:30Z', '2026-10-22T20:00:00Z', '2026-10-22T23:59:00Z']) expect((await check(t)).ran).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it('shares the daily budget with the button: a manual update counts, and the automatic one stops at the limit', async () => {
    await clear(); calls = [];
    await record('2026-10-22T07:10:00Z');                         // someone pressed the button after the first slot
    await record('2026-10-22T09:00:00Z');                         // and again: the daily limit of 2 is now used
    expect((await check('2026-10-22T14:00:30Z')).reason).toMatch(/daily limit of 2 updates is used up/);
    expect(calls).toHaveLength(0);
  });

  it('counts a manual update after a scheduled time as that time\'s update (no second one right after)', async () => {
    await clear(); calls = [];
    await record('2026-10-22T06:20:00Z');
    expect((await check('2026-10-22T06:45:00Z')).reason).toMatch(/already updated since 06:00 UTC/);
    expect(calls).toHaveLength(0);
  });

  it('makes up only the latest missed time when the worker was off, not every missed one', async () => {
    await clear(); calls = [];
    expect((await check('2026-10-22T16:00:00Z', { run: run('2026-10-22T16:00:00Z') })).ran).toBe(true);   // both 06:00 and 14:00 were missed: one update, not two
    expect((await check('2026-10-22T16:05:00Z')).ran).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('keeps the minimum gap after a recent update (a manual one before the slot)', async () => {
    await clear(); calls = [];
    await record('2026-10-22T13:58:00Z');
    expect((await check('2026-10-22T14:03:00Z')).reason).toMatch(/too recent/);
    expect((await check('2026-10-22T14:09:00Z', { run: run('2026-10-22T14:09:00Z') })).ran).toBe(true);
  });

  it('starts fresh each UTC day', async () => {
    await clear(); calls = [];
    await record('2026-10-22T06:00:30Z'); await record('2026-10-22T14:00:30Z');
    expect((await check('2026-10-23T06:00:30Z', { run: run('2026-10-23T06:00:30Z') })).ran).toBe(true);
  });

  it('can be switched off', async () => {
    await clear(); calls = [];
    expect(await check('2026-10-22T07:00:00Z', { cfg: { ...cfg, enabled: false } })).toMatchObject({ ran: false });
    expect(calls).toHaveLength(0);
  });

  it('treats "another sync is already running" as a wait, not a failure, and tries again later', async () => {
    await clear(); calls = [];
    const busy = async () => { throw new SyncBusyError('another sync is already running'); };
    expect(await check('2026-10-22T06:00:30Z', { run: busy })).toMatchObject({ ran: false, reason: expect.stringMatching(/another sync is running/) });
    expect((await check('2026-10-22T06:01:30Z', { run: run('2026-10-22T06:01:30Z') })).ran).toBe(true);
  });

  it('passes a real failure on to the caller (the worker logs it) and a failed attempt that was recorded is not retried for that time', async () => {
    await clear(); calls = [];
    const boom = async () => { await record('2026-10-22T06:00:40Z'); throw new Error('Dune failed'); };
    await expect(check('2026-10-22T06:00:30Z', { run: boom })).rejects.toThrow('Dune failed');
    expect((await check('2026-10-22T06:05:00Z')).reason).toMatch(/already updated since 06:00 UTC/);   // the run was started, so Dune may have billed it
  });
});
