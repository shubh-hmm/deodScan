// Integration test of the alert scan against a THROWAWAY database created on the local PostgreSQL server and dropped afterwards.
// It never touches deod_monitor. When no database server is reachable the whole file is skipped (and reported as skipped).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { loadEnv } from '@deod/config';
import { migrate } from '@deod/db';
import { scanAlerts } from '../src/alerts/scan.js';

const NOW = new Date('2026-10-22T12:00:00Z');
const MEXC_ADDR = '0x4982085c9e2f89f2ecb8131eca71afad896e89cb';
const XT_ADDR = '0xdb3ded7731c781224ec292e2163d9554c094fd7c';
const POOL = '0xd693c42610bd30e63b0a68a25918445a5f9a1d20';
const DEOD = '0x3510fbbc13090f991ffa523527113a166161683e';
const USDT = '0x55d398326f99059ff775485246999027b3197955';
const W1 = '0x1ffbdf86dcd09980ee8e2e89a301c5e15f2d49c7';
const W2 = '0x2222222222222222222222222222222222222222';
const W3 = '0x3333333333333333333333333333333333333333';
const tx = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

let admin: pg.Client | null = null;
let baseUrl = '';
try {
  baseUrl = loadEnv().DATABASE_URL;
  admin = new pg.Client({ connectionString: baseUrl, connectionTimeoutMillis: 3000 });
  await admin.connect();
} catch {
  admin = null;
}

describe.skipIf(!admin)('alert scan on a throwaway database', () => {
  const dbName = `deod_alerts_test_${Date.now()}`;
  let pool: pg.Pool;
  let n = 1000;

  const raw = (amount: string) => (BigInt(Math.round(Number(amount) * 1000)) * 10n ** 15n).toString();
  async function addFlow(o: { exchange: string; direction: 'IN' | 'OUT'; wallet: string; amount: string; time: string; exAddr?: string }) {
    n += 1;
    await pool.query(
      `INSERT INTO exchange_flows (exchange, direction, token_address, wallet_address, exchange_address, amount_raw, amount, tx_hash, evt_index, block_number, block_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $10)`,
      [o.exchange, o.direction, DEOD, o.wallet, o.exAddr ?? (o.exchange === 'xt' ? XT_ADDR : MEXC_ADDR), raw(o.amount), o.amount, tx(n), n, o.time],
    );
    return tx(n);
  }
  async function addSwap(o: { side: 'BUY' | 'SELL'; trader: string; amount: string; time: string }) {
    n += 1;
    await pool.query(
      `INSERT INTO dex_swaps (version, pool_address, tx_hash, evt_index, block_number, block_time, trader_address, side, token_in, amount_in_raw, token_out, amount_out_raw,
                              deod_amount_raw, deod_amount, quote_token, quote_amount_raw, quote_amount, price)
       VALUES ('2', $1, $2, 1, $3, $4, $5, $6, $7, 1, $8, 1, $9, $10, $11, 1, 1, 0.017)`,
      [POOL, tx(n), n, o.time, o.trader, o.side, o.side === 'BUY' ? USDT : DEOD, o.side === 'BUY' ? DEOD : USDT, raw(o.amount), o.amount, USDT],
    );
  }
  const count = async (where = 'true') => Number((await pool.query(`SELECT count(*) AS n FROM alerts WHERE ${where}`)).rows[0].n);
  const byRule = async () => Object.fromEntries((await pool.query(`SELECT rule_code, count(*)::int AS n FROM alerts GROUP BY 1`)).rows.map((r) => [r.rule_code, r.n]));

  beforeAll(async () => {
    await admin!.query(`CREATE DATABASE ${dbName}`);
    pool = new pg.Pool({ connectionString: baseUrl.replace(/\/[^/]*$/, `/${dbName}`), max: 4 });
    await migrate(pool);
    await pool.query(`INSERT INTO exchanges (slug, name) VALUES ('mexc', 'MEXC'), ('xt', 'XT')`);
    await pool.query(
      `INSERT INTO dex_pools (address, version, pair, deod_address, quote_address, quote_symbol, quote_decimals) VALUES ($1, '2', 'DEOD/USDT', $2, $3, 'USDT', 18)`, [POOL, DEOD, USDT]);
    await pool.query(`INSERT INTO dune_sync_state (query_name, synced_until) VALUES ('exchange_transfers', '2026-10-22T00:00:00Z')`);
    await pool.query(`INSERT INTO watched_wallets (address, watch) VALUES ($1, 'incoming')`, [W1]);

    // Quiet baseline: MEXC receives 10,000 DEOD every day from 15 Sep to 18 Oct (34 days of history).
    for (let d = 0; d < 34; d++) {
      const day = new Date(Date.UTC(2026, 8, 15 + d)).toISOString().slice(0, 10);
      await addFlow({ exchange: 'mexc', direction: 'IN', wallet: W3, amount: '10000', time: `${day}T06:00:00Z` });
    }
    await addFlow({ exchange: 'mexc', direction: 'IN', wallet: W3, amount: '400000', time: '2026-10-20T08:00:00Z' });   // 20 Oct total 410,000: a spike
    await addFlow({ exchange: 'mexc', direction: 'IN', wallet: W3, amount: '600000', time: '2026-10-21T10:00:00Z' });   // large transfer (and a spike on 21 Oct)
    await addFlow({ exchange: 'mexc', direction: 'OUT', wallet: W2, amount: '1000', time: '2026-10-21T11:00:00Z' });    // ordinary
    await addFlow({ exchange: 'mexc', direction: 'IN', wallet: W3, amount: '9000000', time: '2026-09-01T00:00:00Z' });  // too old to alert on
    await addFlow({ exchange: 'mexc', direction: 'OUT', wallet: W1, amount: '2000', time: '2026-10-21T12:00:00Z' });    // watched wallet W1 received DEOD
    await addFlow({ exchange: 'mexc', direction: 'IN', wallet: W1, amount: '3000', time: '2026-10-21T13:00:00Z' });     // W1 sent DEOD: not watched (incoming only)
    await addFlow({ exchange: 'mexc', direction: 'IN', wallet: W3, amount: '700000', time: '2026-10-22T08:00:00Z' });   // today (unfinished day): large transfer only
    await addFlow({ exchange: 'xt', direction: 'IN', wallet: W3, amount: '800000', time: '2026-10-21T09:00:00Z' });     // XT: large transfer, no history for a spike
    await addSwap({ side: 'SELL', trader: W2, amount: '60000', time: '2026-10-21T14:00:00Z' });                          // large swap
    await addSwap({ side: 'BUY', trader: W1, amount: '10', time: '2026-10-21T15:00:00Z' });                              // watched wallet bought DEOD
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  it('creates exactly the expected alerts on the first scan', async () => {
    const r = await scanAlerts(pool, { now: NOW });
    expect(await byRule()).toEqual({ large_transfer: 3, large_swap: 1, watched_wallet: 2, flow_spike: 2 });
    expect(r.duplicates).toBe(0);
    expect(r.insufficientHistory).toBeGreaterThanOrEqual(1);                       // XT's day had no history to judge
  });

  it('did not alert on old transfers, ordinary transfers, the unfinished day or an exchange with too little history', async () => {
    expect(await count(`amount = 9000000`)).toBe(0);
    expect(await count(`amount = 1000`)).toBe(0);
    expect(await count(`dedup_key LIKE 'flow_spike:%:2026-10-22'`)).toBe(0);
    expect(await count(`rule_code = 'flow_spike' AND exchange = 'xt'`)).toBe(0);
    expect(await count(`dedup_key LIKE 'flow_spike:mexc:IN:2026-10-20'`)).toBe(1);
  });

  it('watches only the direction asked for and stores amount, sender, recipient, time, hash and block', async () => {
    const { rows } = await pool.query(`SELECT * FROM alerts WHERE rule_code = 'watched_wallet' ORDER BY occurred_at`);
    expect(rows).toHaveLength(2);
    expect(rows.every((a) => a.wallet_address === W1)).toBe(true);
    const received = rows[0];
    expect(received).toMatchObject({ direction: 'OUT', sender: MEXC_ADDR, recipient: W1, source: 'exchange_flow' });
    expect(received.tx_hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(Number(received.amount)).toBe(2000);
    expect(received.occurred_at.toISOString()).toBe('2026-10-21T12:00:00.000Z');
    expect(rows[1]).toMatchObject({ direction: 'BUY', sender: POOL, recipient: W1, source: 'swap' });
  });

  it('a second scan of unchanged data adds nothing', async () => {
    const before = await count();
    const r = await scanAlerts(pool, { now: NOW });
    expect(r.scannedFlows).toBe(0);
    expect(r.scannedSwaps).toBe(0);
    expect(r.inserted).toEqual({});
    expect(await count()).toBe(before);
  });

  it('a full rescan re-examines everything but still creates no duplicate', async () => {
    const before = await count();
    const r = await scanAlerts(pool, { now: NOW, rescan: true });
    expect(r.scannedFlows).toBeGreaterThan(0);
    expect(r.inserted).toEqual({});
    expect(r.duplicates).toBe(before);                      // every candidate already existed
    expect(await count()).toBe(before);
    expect((await pool.query(`SELECT count(DISTINCT dedup_key)::int AS n FROM alerts`)).rows[0].n).toBe(before);
  });

  it('a new transfer after the scan produces exactly one new alert, once', async () => {
    const before = await count();
    await addFlow({ exchange: 'mexc', direction: 'IN', wallet: W3, amount: '650000', time: '2026-10-22T09:00:00Z' });
    expect((await scanAlerts(pool, { now: NOW })).inserted).toEqual({ large_transfer: 1 });
    expect(await count()).toBe(before + 1);
    expect((await scanAlerts(pool, { now: NOW })).inserted).toEqual({});
    expect(await count()).toBe(before + 1);
  });

  it('a wallet added to the watchlist later is alerted on for NEW activity only, not for what was already scanned', async () => {
    await pool.query(`INSERT INTO watched_wallets (address, watch) VALUES ($1, 'both')`, [W2]);
    expect((await scanAlerts(pool, { now: NOW })).inserted).toEqual({});               // W2's earlier SELL / OUT were scanned before it was watched
    await addFlow({ exchange: 'mexc', direction: 'IN', wallet: W2, amount: '5', time: '2026-10-22T10:00:00Z' });
    expect((await scanAlerts(pool, { now: NOW })).inserted).toEqual({ watched_wallet: 1 });
  });

  it('skips the daily-flow rule and says why when the sync has no checkpoint (incomplete data)', async () => {
    await pool.query(`UPDATE dune_sync_state SET synced_until = NULL WHERE query_name = 'exchange_transfers'`);
    const r = await scanAlerts(pool, { now: NOW, rescan: true });
    expect(r.spikeSkippedReason).toBe('no sync checkpoint yet');
    expect(r.daysExamined).toBe(0);
  });

  it('does not judge a day the sync has not fully covered', async () => {
    await pool.query(`DELETE FROM alerts WHERE rule_code = 'flow_spike'`);
    await pool.query(`UPDATE dune_sync_state SET synced_until = '2026-10-20T00:00:00Z' WHERE query_name = 'exchange_transfers'`);   // days up to 19 Oct only
    await scanAlerts(pool, { now: NOW, rescan: true });
    expect(await count(`rule_code = 'flow_spike'`)).toBe(0);                            // the spikes were on 20 and 21 Oct
  });
});
