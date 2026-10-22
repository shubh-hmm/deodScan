// The daily limit of "Update today": how uses are counted and when the next one is refused. Runs on a THROWAWAY database; skipped when none is reachable.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { loadEnv } from '@deod/config';
import { migrate } from '@deod/db';
import { SyncLimitError, TODAY_MAX_PER_DAY, todayCooldownSeconds, todayUsage } from '../src/sync.js';

let admin: pg.Client | null = null;
let baseUrl = '';
try {
  baseUrl = loadEnv().DATABASE_URL;
  admin = new pg.Client({ connectionString: baseUrl, connectionTimeoutMillis: 3000 });
  await admin.connect();
} catch {
  admin = null;
}

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

describe.skipIf(!admin)('counting uses', () => {
  const dbName = `deod_limit_test_${Date.now()}`;
  let pool: pg.Pool;
  // One use starts one run per query (transfers and swaps), so each use is recorded as two rows.
  const use = async (at: string, status = 'ok', mode = 'today') => {
    for (const q of ['exchange_transfers', 'pancakeswap_swaps']) {
      await pool.query(`INSERT INTO sync_runs (query_name, mode, window_start, window_end, started_at, status) VALUES ($1, $2, $3, $3, $4, $5)`, [q, mode, at, at, status]);
    }
  };
  const clear = () => pool.query('DELETE FROM sync_runs');

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
