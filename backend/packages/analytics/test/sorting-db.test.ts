// Regression test: "sort by amount" must order by NUMBER. It once ordered by the text form of the amount ("9.97" ahead of "1270524.83"), so the
// Exchange flows and Swaps pages (and their CSV exports) listed the wrong transfers first. Runs on a THROWAWAY database; skipped when none is reachable.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { loadEnv } from '@deod/config';
import { migrate } from '@deod/db';
import { FlowFilter, SwapFilter, listFlows, listSwaps, type Window } from '../src/index.js';

let admin: pg.Client | null = null;
let baseUrl = '';
try {
  baseUrl = loadEnv().DATABASE_URL;
  admin = new pg.Client({ connectionString: baseUrl, connectionTimeoutMillis: 3000 });
  await admin.connect();
} catch {
  admin = null;
}

const DEOD = '0x3510fbbc13090f991ffa523527113a166161683e';
const USDT = '0x55d398326f99059ff775485246999027b3197955';
const POOL = '0xd693c42610bd30e63b0a68a25918445a5f9a1d20';
const w: Window = { from: null, to: new Date('2026-10-22T00:00:00Z'), range: 'all', bucket: 'day' };
const raw = (a: string) => (BigInt(Math.round(Number(a) * 100)) * 10n ** 16n).toString();

describe.skipIf(!admin)('sorting by amount', () => {
  const dbName = `deod_sort_test_${Date.now()}`;
  let pool: pg.Pool;

  beforeAll(async () => {
    await admin!.query(`CREATE DATABASE ${dbName}`);
    pool = new pg.Pool({ connectionString: baseUrl.replace(/\/[^/]*$/, `/${dbName}`), max: 4 });
    await migrate(pool);
    await pool.query(`INSERT INTO exchanges (slug, name) VALUES ('mexc', 'MEXC')`);
    await pool.query(`INSERT INTO dex_pools (address, version, pair, deod_address, quote_address, quote_symbol, quote_decimals) VALUES ($1, '2', 'DEOD/USDT', $2, $3, 'USDT', 18)`, [POOL, DEOD, USDT]);
    let n = 0;
    for (const a of ['9.97', '1270524.83', '99999', '100', '29158937.7564', '999985']) {
      n += 1;
      await pool.query(
        `INSERT INTO exchange_flows (exchange, direction, token_address, wallet_address, exchange_address, amount_raw, amount, tx_hash, evt_index, block_number, block_time)
         VALUES ('mexc', 'IN', $1, $2, $2, $3, $4, $5, 1, $6, '2026-10-20T00:00:00Z')`, [DEOD, '0x1111111111111111111111111111111111111111', raw(a), a, `0x${n.toString(16).padStart(64, '0')}`, n]);
      await pool.query(
        `INSERT INTO dex_swaps (version, pool_address, tx_hash, evt_index, block_number, block_time, trader_address, side, token_in, amount_in_raw, token_out, amount_out_raw,
                                deod_amount_raw, deod_amount, quote_token, quote_amount_raw, quote_amount, price)
         VALUES ('2', $1, $2, 1, $3, '2026-10-20T00:00:00Z', '0x1111111111111111111111111111111111111111', 'SELL', $4, 1, $5, 1, $6, $7, $5, 1, 1, 0.017)`,
        [POOL, `0x${(n + 100).toString(16).padStart(64, '0')}`, n, DEOD, USDT, raw(a), a]);
    }
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  it('lists exchange transfers largest first by number', async () => {
    const r = await listFlows(pool, w, FlowFilter.parse({ sort: 'amount', limit: 10 }));
    expect(r.rows.map((x) => Number(x.amount))).toEqual([29158937.7564, 1270524.83, 999985, 99999, 100, 9.97]);
  });

  it('lists swaps largest first by number', async () => {
    const r = await listSwaps(pool, w, SwapFilter.parse({ sort: 'amount', limit: 10 }));
    expect(r.rows.map((x) => Number(x.deod_amount))).toEqual([29158937.7564, 1270524.83, 999985, 99999, 100, 9.97]);
  });

  it('still orders by time when asked to, and paging by amount does not skip or repeat rows', async () => {
    const byTime = await listFlows(pool, w, FlowFilter.parse({ sort: 'time', limit: 10 }));
    expect(byTime.rows).toHaveLength(6);
    const page1 = await listFlows(pool, w, FlowFilter.parse({ sort: 'amount', limit: 3, offset: 0 }));
    const page2 = await listFlows(pool, w, FlowFilter.parse({ sort: 'amount', limit: 3, offset: 3 }));
    expect([...page1.rows, ...page2.rows].map((x) => Number(x.amount))).toEqual([29158937.7564, 1270524.83, 999985, 99999, 100, 9.97]);
  });
});
