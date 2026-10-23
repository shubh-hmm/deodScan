// The daily limit of "Update today": how uses are counted and when the next one is refused. Runs on a THROWAWAY database; skipped when none is reachable.
import { afterAll, describe, expect, it } from 'vitest';
import { addSyncRuns, createScratchDb } from '@deod/db';
import { SyncLimitError, TODAY_MAX_PER_DAY, todayCooldownSeconds, todayUsage } from '../src/sync.js';

const scratch = await createScratchDb('deod_limit_test');

const NOW = new Date('2026-10-22T12:00:00Z');

describe('the default', () => {
  it('allows two uses per UTC day', () => {
    expect(TODAY_MAX_PER_DAY).toBe(2);
  });
  it('explains the limit in plain words', () => {
    expect(new SyncLimitError(2).message).toBe('"Update today" has already been used 2 times today, which is the limit. It resets at 00:00 UTC; finished days are still synced automatically.');
    expect(new SyncLimitError(1).message).toContain('1 time today');
  });
});

describe.skipIf(!scratch)('counting uses', () => {
  const pool = scratch!.db;
  // One use starts one run per query (transfers and swaps), so each use is recorded as two rows.
  const use = (at: string, status = 'ok', mode = 'today') => addSyncRuns(pool, at, mode, status);
  const clear = () => pool.collection('sync_runs').deleteMany({});

  afterAll(() => scratch?.drop());

  it('starts at zero used and two left', async () => {
    await clear();
    expect(await todayUsage(NOW, pool)).toEqual({ used: 0, max: 2, remaining: 2 });
  });

  it('counts a use once, not once per query', async () => {
    await clear();
    await use('2026-10-22T06:56:00Z');
    expect(await todayUsage(NOW, pool)).toEqual({ used: 1, max: 2, remaining: 1 });
  });

  it('is used up after two uses, and never goes below zero', async () => {
    await clear();
    await use('2026-10-22T06:56:00Z');
    await use('2026-10-22T11:30:00Z');
    expect((await todayUsage(NOW, pool)).remaining).toBe(0);
    await use('2026-10-22T11:45:00Z');
    expect(await todayUsage(NOW, pool)).toMatchObject({ used: 3, remaining: 0 });
  });

  it('counts a use that failed, because a started Dune run is billed', async () => {
    await clear();
    await use('2026-10-22T06:56:00Z', 'error');
    expect((await todayUsage(NOW, pool)).used).toBe(1);
  });

  it('does not count yesterday, other kinds of sync, or the next UTC day', async () => {
    await clear();
    await use('2026-10-21T23:59:59Z');                      // yesterday, just before midnight UTC
    await use('2026-10-22T03:00:00Z', 'ok', 'daily');       // the automatic daily sync is not an Update today
    await use('2026-10-22T04:00:00Z', 'ok', 'backfill');
    expect((await todayUsage(NOW, pool)).used).toBe(0);
    expect((await todayUsage(new Date('2026-10-22T00:00:00Z'), pool)).used).toBe(0);
  });

  it('resets at 00:00 UTC', async () => {
    await clear();
    await use('2026-10-22T06:56:00Z');
    await use('2026-10-22T11:30:00Z');
    expect((await todayUsage(NOW, pool)).remaining).toBe(0);
    expect(await todayUsage(new Date('2026-10-23T00:00:01Z'), pool)).toEqual({ used: 0, max: 2, remaining: 2 });
  });

  it('keeps the short cooldown between two uses as well', async () => {
    await clear();
    await use('2026-10-22T11:55:00Z');                      // five minutes before NOW
    expect(await todayCooldownSeconds(NOW, pool)).toBeGreaterThan(0);
    expect(await todayCooldownSeconds(new Date('2026-10-22T12:30:00Z'), pool)).toBe(0);
  });
});
