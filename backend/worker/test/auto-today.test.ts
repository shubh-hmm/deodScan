// Automatic updates of today's data: when they are due, how they share the daily budget with the button, and that they never run twice for one
// time slot. The update itself is replaced by a stand-in, so nothing here calls Dune. Runs on a THROWAWAY database; skipped when none is reachable.
import { afterAll, describe, expect, it } from 'vitest';
import { addSyncRuns, createScratchDb } from '@deod/db';
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

const scratch = await createScratchDb('deod_auto_test');

describe.skipIf(!scratch)('when an automatic update is due', () => {
  const pool = scratch!.db;
  const cfg: AutoConfig = { enabled: true, slots: parseTimes('06:00,14:00')!, warning: null };
  const record = (at: string, mode = 'today_auto') => addSyncRuns(pool, at, mode);   // one update = one run per query; 'today' = a button press, 'today_auto' = the schedule
  const clear = () => pool.collection('sync_runs').deleteMany({});
  let calls: Date[] = [];
  const run = (at?: string) => async (now: Date) => { calls.push(now); if (at) await record(at); };
  const check = (when: string, opts: { cfg?: AutoConfig; run?: (n: Date) => Promise<unknown> } = {}) =>
    autoUpdateCheck(new Date(when), opts.cfg ?? cfg, pool, opts.run ?? run());

  afterAll(() => scratch?.drop());

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
      expect(r.reason).toMatch(/scheduled update already ran since 06:00 UTC/);
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

  it('is ADDITIONAL to the button: any number of button presses never skips or blocks a scheduled update', async () => {
    await clear(); calls = [];
    await record('2026-10-22T06:10:00Z', 'today'); await record('2026-10-22T09:00:00Z', 'today'); await record('2026-10-22T10:00:00Z', 'today');
    const r = await check('2026-10-22T14:00:30Z', { run: run('2026-10-22T14:00:30Z') });
    expect(r.ran).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('runs both scheduled updates even when the button was used right after each', async () => {
    await clear(); calls = [];
    await check('2026-10-22T06:00:30Z', { run: run('2026-10-22T06:00:30Z') });
    await record('2026-10-22T06:30:00Z', 'today');                // a press after the 06:00 update
    expect((await check('2026-10-22T06:45:00Z')).reason).toMatch(/scheduled update already ran since 06:00 UTC/);
    expect((await check('2026-10-22T14:00:30Z', { run: run('2026-10-22T14:00:30Z') })).ran).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('makes up only the latest missed time when the worker was off, not every missed one', async () => {
    await clear(); calls = [];
    expect((await check('2026-10-22T16:00:00Z', { run: run('2026-10-22T16:00:00Z') })).ran).toBe(true);   // both 06:00 and 14:00 were missed: one update, not two
    expect((await check('2026-10-22T16:05:00Z')).ran).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('keeps the minimum gap after a recent update of any kind (a manual one just before the slot)', async () => {
    await clear(); calls = [];
    await record('2026-10-22T13:58:00Z', 'today');
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
    expect((await check('2026-10-22T06:05:00Z')).reason).toMatch(/scheduled update already ran since 06:00 UTC/);   // the run was started, so Dune may have billed it
  });
});
