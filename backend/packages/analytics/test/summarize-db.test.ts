// summarize() against a THROWAWAY database: the real queries behind the dashboard summary. Skipped (and reported as skipped) when no database
// server is reachable; deod_monitor is never touched.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { loadEnv } from '@deod/config';
import { migrate } from '@deod/db';
import { summarize } from '../src/summary.js';
import type { Window } from '../src/index.js';

let admin: pg.Client | null = null;
let baseUrl = '';
try {
  baseUrl = loadEnv().DATABASE_URL;
  admin = new pg.Client({ connectionString: baseUrl, connectionTimeoutMillis: 3000 });
  await admin.connect();
} catch {
  admin = null;
}

const MEXC = '0x4982085c9e2f89f2ecb8131eca71afad896e89cb';
const DEOD = '0x3510fbbc13090f991ffa523527113a166161683e';
const w = (from: string, to: string, range = '7d'): Window => ({ from: new Date(from), to: new Date(to), range: range as Window['range'], bucket: 'day' });

describe.skipIf(!admin)('summary from the database', () => {
  const dbName = `deod_summary_test_${Date.now()}`;
  let pool: pg.Pool;
  let n = 100;
  const flow = async (exchange: string, direction: 'IN' | 'OUT', amount: string, time: string, wallet = '0x1111111111111111111111111111111111111111') => {
    n += 1;
    await pool.query(
      `INSERT INTO exchange_flows (exchange, direction, token_address, wallet_address, exchange_address, amount_raw, amount, tx_hash, evt_index, block_number, block_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $10)`,
      [exchange, direction, DEOD, wallet, MEXC, (BigInt(Math.round(Number(amount) * 100)) * 10n ** 16n).toString(), amount, `0x${n.toString(16).padStart(64, '0')}`, n, time]);
    return `0x${n.toString(16).padStart(64, '0')}`;
  };

  beforeAll(async () => {
    await admin!.query(`CREATE DATABASE ${dbName}`);
    pool = new pg.Pool({ connectionString: baseUrl.replace(/\/[^/]*$/, `/${dbName}`), max: 4 });
    await migrate(pool);
    await pool.query(`INSERT INTO exchanges (slug, name) VALUES ('mexc', 'MEXC'), ('toobit', 'Toobit')`);
    await pool.query(`INSERT INTO dune_sync_state (query_name, synced_until) VALUES ('exchange_transfers', '2026-10-22T00:00:00Z'), ('pancakeswap_swaps', '2026-10-22T00:00:00Z')`);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  it('picks the largest transfer by NUMBER, not by text ("9.97" is not bigger than "1270524.83")', async () => {
    await flow('mexc', 'IN', '9.97', '2026-10-20T10:00:00Z');
    await flow('mexc', 'IN', '99999', '2026-10-20T11:00:00Z');
    const big = await flow('toobit', 'OUT', '1270524.83', '2026-10-18T15:28:00Z');
    await flow('mexc', 'OUT', '5000', '2026-10-21T09:00:00Z');
    const s = await summarize(pool, w('2026-10-15T10:40:00Z', '2026-10-22T10:40:00Z'));
    const line = s.sections.find((x) => x.title === 'Largest single transfer')!.lines[0]!;
    expect(line).toContain('1.27M DEOD withdrawn from Toobit');
    expect(line).toContain(big);
  });

  it('adds up exactly what the dashboard overview adds up', async () => {
    const s = await summarize(pool, w('2026-10-15T10:40:00Z', '2026-10-22T10:40:00Z'));
    // IN: 9.97 + 99999 = 100,008.97 ; OUT: 1,270,524.83 + 5,000 = 1,275,524.83 ; net outflow 1,175,515.86
    expect(s.headline).toContain('100.01K DEOD was deposited to exchanges and 1.28M DEOD withdrawn');
    expect(s.headline).toContain('net outflow of 1.18M DEOD');
    expect(s.sections.find((x) => x.title === 'Exchanges')!.lines).toContain('Toobit: 0 DEOD in (0 deposits), 1.27M DEOD out (1 withdrawal), net -1.27M.');
    expect(s.sections.find((x) => x.title === 'PancakeSwap')!.lines).toEqual(['No swaps recorded in this period.']);
  });

  it('only counts the chosen period, compares with the one before it, and reports alerts', async () => {
    await flow('mexc', 'IN', '40000', '2026-10-10T10:00:00Z');                          // previous 7 days only
    await pool.query(`INSERT INTO alert_rules (code, kind, name, severity) VALUES ('large_transfer', 'large_transfer', 'Large exchange transfer', 'high')`);
    await pool.query(`INSERT INTO alerts (dedup_key, rule_code, severity, source, occurred_at, amount) VALUES ('a', 'large_transfer', 'high', 'exchange_flow', '2026-10-18T15:28:00Z', 1270524.83), ('b', 'large_transfer', 'high', 'exchange_flow', '2026-10-01T00:00:00Z', 5)`);
    const s = await summarize(pool, w('2026-10-15T10:40:00Z', '2026-10-22T10:40:00Z'));
    expect(s.sections.find((x) => x.title === 'Alerts')!.lines[0]).toBe('1 alert raised: 1 large transfer.');
    expect(s.sections.find((x) => x.title === 'Compared with the previous period of the same length')!.lines[0]).toContain('deposits up 150%');   // 100,008.97 vs 40,000
  });

  it('describes a period with no data honestly, and notes how far the data goes', async () => {
    const s = await summarize(pool, w('2026-10-22T08:00:00Z', '2026-10-22T10:00:00Z', '6h'));
    expect(s.headline).toBe('No DEOD activity is recorded for the last 6 hours.');
    expect(s.notes.some((x) => x.includes('later than the last synced data'))).toBe(true);
  });

  it('works for all time, which has no previous period', async () => {
    const s = await summarize(pool, { from: null, to: new Date('2026-10-22T10:40:00Z'), range: 'all', bucket: 'day' });
    expect(s.period).toBe('all recorded history');
    expect(s.sections.find((x) => x.title === 'Compared with the previous period of the same length')).toBeUndefined();
  });
});
