// Every dashboard query against a THROWAWAY database filled with a small data set whose answers were worked out by hand. This is what keeps the
// numbers on the pages right: sums, counts, distinct wallets, buckets, rankings, filters and paging. Skipped when no database server is reachable.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addExchanges, addFlow, addSwap, addSyncRuns, createScratchDb, nextIds, refreshWalletSummary, setSyncedUntil, testTx, toDec128,
} from '@deod/db';
import * as A from '../src/index.js';

const scratch = await createScratchDb('deod_queries_test');
const POOL_V3 = '0x92b7807bf19b7dddf89b706143896d05228f3121';
const a = '0x' + 'a'.repeat(40), b = '0x' + 'b'.repeat(40), c = '0x' + 'c'.repeat(40);
const MEXC_ADDR = '0x4982085c9e2f89f2ecb8131eca71afad896e89cb', TOOBIT_ADDR = '0xb0b1177e8b32bfb9744c50f1350c6a614cc1aa77';
const win = (from: string | null, to: string, bucket: 'hour' | 'day' = 'day'): A.Window => ({ from: from ? new Date(from) : null, to: new Date(to), range: from ? 'custom' : 'all', bucket });
const W = win('2026-10-15T00:00:00Z', '2026-10-22T00:00:00Z');
const ALL = win(null, '2026-10-22T00:00:00Z');
const T = (n: number) => testTx(n);

afterAll(() => scratch?.drop());

describe.skipIf(!scratch)('dashboard queries on a known data set', () => {
  const db = scratch!.db;

  beforeAll(async () => {
    await addExchanges(db, { mexc: 'MEXC', toobit: 'Toobit', xt: 'XT' });
    const f = (exchange: string, direction: 'IN' | 'OUT', wallet: string, amount: string, time: string, tx: string, exAddr = MEXC_ADDR) =>
      addFlow(db, { exchange, direction, wallet, amount, time, tx, exchangeAddress: exAddr });
    await f('mexc', 'IN', a, '100', '2026-10-20T10:15:00Z', T(1));
    await f('mexc', 'IN', b, '50.5', '2026-10-20T10:45:00Z', T(2));
    await f('mexc', 'OUT', a, '20', '2026-10-20T14:00:00Z', T(3));
    await f('toobit', 'IN', a, '1000', '2026-10-21T01:00:00Z', T(4), TOOBIT_ADDR);
    await f('toobit', 'OUT', c, '300.25', '2026-10-21T23:30:00Z', T(5), TOOBIT_ADDR);
    await f('mexc', 'IN', a, '7', '2026-10-10T00:00:00Z', T(6));                                  // before the 7-day window
    await addSwap(db, { side: 'BUY', trader: a, amount: '10', price: '0.5', usd: '5', time: '2026-10-20T12:00:00Z', tx: T(11), version: '2', recipient: c });
    await addSwap(db, { side: 'SELL', trader: b, amount: '4', price: '0.4', usd: '1.6', time: '2026-10-20T13:00:00Z', tx: T(12), version: '2' });
    await addSwap(db, { side: 'BUY', trader: c, amount: '100', price: '0.6', usd: '60', time: '2026-10-21T09:00:00Z', tx: T(13), version: '3', pool: POOL_V3 });
    await addSwap(db, { side: 'SELL', trader: a, amount: '2', price: '0.55', usd: '1.1', time: '2026-10-21T10:00:00Z', tx: T(14), version: '3', pool: POOL_V3 });
    await refreshWalletSummary(db);
  }, 60_000);

  it('overview(): per-exchange sums, counts and distinct wallets, totals, and PancakeSwap', async () => {
    const o = await A.overview(db, W);
    const byEx = Object.fromEntries(o.exchanges.map((e) => [e.exchange, e]));
    expect(o.exchanges.map((e) => e.name)).toEqual(['MEXC', 'Toobit', 'XT']);                 // alphabetical, quiet exchanges included
    expect(byEx.mexc).toEqual({ exchange: 'mexc', name: 'MEXC', inflow: '150.500000000000000000', outflow: '20.000000000000000000', net: '130.500000000000000000', deposits: 2, withdrawals: 1, unique_wallets: 2 });
    expect(byEx.toobit).toMatchObject({ inflow: '1000.000000000000000000', outflow: '300.250000000000000000', net: '699.750000000000000000', deposits: 1, withdrawals: 1, unique_wallets: 2 });
    expect(byEx.xt).toEqual({ exchange: 'xt', name: 'XT', inflow: '0', outflow: '0', net: '0', deposits: 0, withdrawals: 0, unique_wallets: 0 });
    expect(o.totals).toEqual({ inflow: '1150.500000000000000000', outflow: '320.250000000000000000', net: '830.250000000000000000', uniqueWallets: 3, exchangeTransfers: 0 });
    expect(o.pancakeswap).toMatchObject({ swaps: 4, buys: 2, sells: 2, unique_wallets: 3, deod_volume: '116.000000000000000000', buy_deod: '110.000000000000000000', sell_deod: '6.000000000000000000' });
  });

  it('overview(): a negative net stays negative, and an empty window is all zeros', async () => {
    const o = await A.overview(db, win('2026-10-21T12:00:00Z', '2026-10-22T00:00:00Z'));
    expect(o.totals).toMatchObject({ inflow: '0', outflow: '300.250000000000000000', net: '-300.250000000000000000' });
    const empty = await A.overview(db, win('2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'));
    expect(empty.totals).toEqual({ inflow: '0', outflow: '0', net: '0', uniqueWallets: 0, exchangeTransfers: 0 });
    expect(empty.pancakeswap).toMatchObject({ swaps: 0, deod_volume: '0', largest_swap_deod: null, last_price: null, last_swap_time: null, unique_wallets: 0 });
  });

  it('the window is [from, to): the first instant counts, the last does not', async () => {
    const o = await A.exchangeStats(db, 'mexc', win('2026-10-20T10:15:00Z', '2026-10-20T10:45:00Z'));
    expect(o).toMatchObject({ deposits: 1, inflow: '100.000000000000000000' });
  });

  it('exchangeStats(): sums, distinct depositors and withdrawers, largest', async () => {
    expect(await A.exchangeStats(db, 'mexc', W)).toEqual({
      inflow: '150.500000000000000000', outflow: '20.000000000000000000', net: '130.500000000000000000', deposits: 2, withdrawals: 1,
      unique_depositors: 2, unique_withdrawers: 1, unique_wallets: 2, largest_deposit: '100.000000000000000000', largest_withdrawal: '20.000000000000000000',
    });
    expect(await A.exchangeStats(db, 'xt', W)).toMatchObject({ inflow: '0', deposits: 0, unique_wallets: 0, largest_deposit: null, largest_withdrawal: null });
    expect((await A.exchangeStats(db, 'mexc', ALL)).inflow).toBe('157.500000000000000000');       // all time includes the 7 DEOD from 10 Oct
  });

  it('flowSeries(): day buckets in UTC, ordered, empty buckets left out', async () => {
    const rows = await A.flowSeries(db, W);
    expect(rows.map((r) => [r.bucket.toISOString(), r.exchange, r.inflow, r.outflow])).toEqual([
      ['2026-10-20T00:00:00.000Z', 'mexc', '150.500000000000000000', '20.000000000000000000'],
      ['2026-10-21T00:00:00.000Z', 'toobit', '1000.000000000000000000', '300.250000000000000000'],
    ]);
    expect((await A.flowSeries(db, W, 'toobit')).map((r) => r.exchange)).toEqual(['toobit']);
  });

  it('flowSeries(): hour buckets', async () => {
    const rows = await A.flowSeries(db, win('2026-10-20T00:00:00Z', '2026-10-21T00:00:00Z', 'hour'), 'mexc');
    expect(rows.map((r) => [r.bucket.toISOString(), r.inflow, r.outflow])).toEqual([
      ['2026-10-20T10:00:00.000Z', '150.500000000000000000', '0'],
      ['2026-10-20T14:00:00.000Z', '0', '20.000000000000000000'],
    ]);
  });

  it('hourlyActivity(): 24 hours, zeros where nothing happened', async () => {
    const rows = await A.hourlyActivity(db, W);
    expect(rows).toHaveLength(24);
    expect(rows.map((r) => r.hour)).toEqual([...Array(24).keys()]);
    const pick = (h: number) => rows[h];
    expect(pick(10)).toEqual({ hour: 10, inflows: 2, outflows: 0 });
    expect(pick(14)).toEqual({ hour: 14, inflows: 0, outflows: 1 });
    expect(pick(1)).toEqual({ hour: 1, inflows: 1, outflows: 0 });
    expect(pick(23)).toEqual({ hour: 23, inflows: 0, outflows: 1 });
    expect(rows.reduce((n, r) => n + r.inflows + r.outflows, 0)).toBe(5);
  });

  it('listActivity(): transfers and swaps together, newest first, with common columns', async () => {
    const rows = await A.listActivity(db, W, 3);
    expect(rows.map((r) => [r.type, r.tx_hash])).toEqual([['exchange', T(5)], ['swap', T(14)], ['swap', T(13)]]);
    expect(rows[0]).toMatchObject({ venue: 'toobit', action: 'OUT', wallet_address: c, counterparty: TOOBIT_ADDR, deod_amount: '300.250000000000000000', quote_amount: null, price: null, usd_value: null });
    expect(rows[1]).toMatchObject({ venue: 'pancakeswap_v3', action: 'SELL', wallet_address: a, counterparty: POOL_V3, deod_amount: '2.000000000000000000', price: '0.550000000000000000000000000000', usd_value: '1.100000000000000000' });
    expect((await A.listActivity(db, W, 100))).toHaveLength(9);
  });

  it('listFlows(): filters combine, the total ignores paging, and the amount text is exact', async () => {
    const r = await A.listFlows(db, W, A.FlowFilter.parse({ exchange: 'mexc', direction: 'IN' }));
    expect(r.total).toBe(2);
    expect(r.rows.map((x) => x.tx_hash)).toEqual([T(2), T(1)]);                                // newest first
    const wallet = await A.listFlows(db, W, A.FlowFilter.parse({ wallet: a.toUpperCase().replace('0X', '0x') }));
    expect(wallet.total).toBe(3);
    const page = await A.listFlows(db, W, A.FlowFilter.parse({ limit: 2, offset: 4 }));
    expect(page.total).toBe(5);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({ amount: '100.000000000000000000', amount_raw: '100000000000000000000', block_number: expect.any(Number) });
  });

  it('listSwaps(): version, side and wallet filters', async () => {
    expect((await A.listSwaps(db, W, A.SwapFilter.parse({ version: '3' }))).rows.map((r) => r.tx_hash)).toEqual([T(14), T(13)]);
    expect((await A.listSwaps(db, W, A.SwapFilter.parse({ side: 'BUY' }))).total).toBe(2);
    const mine = await A.listSwaps(db, W, A.SwapFilter.parse({ wallet: a }));
    expect(mine.total).toBe(2);
    expect(mine.rows[0]).toMatchObject({ trader_address: a, usd_basis: 'usdt_peg', recipient_address: null });
    expect((await A.listSwaps(db, W, A.SwapFilter.parse({ wallet: a, version: '2' }))).rows[0]).toMatchObject({ recipient_address: c, price: '0.500000000000000000000000000000' });
  });

  it('topExchangeWallets(): ranked by total, with count, largest and first / last seen', async () => {
    const rows = await A.topExchangeWallets(db, 'mexc', 'IN', ALL);
    expect(rows.map((r) => [r.wallet_address, r.total, r.transfers, r.largest])).toEqual([
      [a, '107.000000000000000000', 2, '100.000000000000000000'], [b, '50.500000000000000000', 1, '50.500000000000000000'],
    ]);
    expect(rows[0]!.first_seen).toEqual(new Date('2026-10-10T00:00:00Z'));
    expect(rows[0]!.last_seen).toEqual(new Date('2026-10-20T10:15:00Z'));
    expect(await A.topExchangeWallets(db, 'mexc', 'IN', ALL, 1)).toHaveLength(1);
  });

  it('pancakeStats(): totals, per-version filter, and the last price by block order', async () => {
    const all = await A.pancakeStats(db, W, 'all');
    expect(all).toMatchObject({
      swaps: 4, usd_volume: '67.700000000000000000', buy_usd: '65.000000000000000000', sell_usd: '2.700000000000000000',
      largest_swap_deod: '100.000000000000000000', last_price: '0.550000000000000000000000000000', last_swap_time: new Date('2026-10-21T10:00:00Z'),
    });
    expect(await A.pancakeStats(db, W, '2')).toMatchObject({ swaps: 2, deod_volume: '14.000000000000000000', last_price: '0.400000000000000000000000000000', unique_wallets: 2 });
    expect(await A.pancakeStats(db, W, '3')).toMatchObject({ swaps: 2, buys: 1, sells: 1, last_price: '0.550000000000000000000000000000' });
  });

  it('swapSeries(): one row per day and pool version', async () => {
    const rows = await A.swapSeries(db, W, 'all');
    expect(rows.map((r) => [r.bucket.toISOString().slice(0, 10), r.version, r.buy_deod, r.sell_deod, r.swaps])).toEqual([
      ['2026-10-20', '2', '10.000000000000000000', '4.000000000000000000', 2],
      ['2026-10-21', '3', '100.000000000000000000', '2.000000000000000000', 2],
    ]);
  });

  it('topWallets(): ranking by volume across exchanges and swaps, with distinct transactions', async () => {
    const rows = await A.topWallets(db, W, A.TopWalletQuery.parse({}));
    expect(rows.map((r) => r.wallet_address)).toEqual([a, c, b]);
    expect(rows[0]).toMatchObject({
      volume: '1132.000000000000000000', transactions: 5, largest: '1000.000000000000000000', sent_to_exchanges: '1100.000000000000000000',
      received_from_exchanges: '20.000000000000000000', swap_buy: '10.000000000000000000', swap_sell: '2.000000000000000000',
    });
    expect(rows[0]!.first_seen).toEqual(new Date('2026-10-20T10:15:00Z'));
    expect(rows[0]!.last_seen).toEqual(new Date('2026-10-21T10:00:00Z'));
  });

  it('topWallets(): sources, minimums, other sort orders and the limit', async () => {
    const top = (q: object) => A.topWallets(db, W, A.TopWalletQuery.parse(q)).then((r) => r.map((x) => x.wallet_address));
    expect(await top({ source: 'pancakeswap' })).toEqual([c, a, b]);                              // 100, 12, 4
    expect(await top({ source: 'pancakeswap_v3' })).toEqual([c, a]);
    expect(await top({ source: 'pancakeswap_v2' })).toEqual([a, b]);
    expect(await top({ source: 'mexc' })).toEqual([a, b]);                                        // 120 and 50.5
    expect(await top({ source: 'toobit' })).toEqual([a, c]);                                      // 1000 and 300.25
    expect(await top({ source: 'nosuchexchange' })).toEqual([]);
    expect(await top({ minVolume: 100 })).toEqual([a, c]);
    expect(await top({ minTx: 3 })).toEqual([a]);
    expect(await top({ sort: 'buy' })).toEqual([c, a, b]);
    expect(await top({ sort: 'sell' })).toEqual([b, a, c]);                                       // sold 4, 2, 0
    expect(await top({ sort: 'transactions', limit: 1 })).toEqual([a]);
    expect(await top({ sort: 'received_from_exchanges' })).toEqual([c, a, b]);                    // 300.25, 20, 0
  });

  it('walletProfile(): summary, per-exchange and per-pool breakdown, swaps as recipient only', async () => {
    const p = await A.walletProfile(db, a);
    expect(p.summary).toMatchObject({
      address: a, transaction_count: 6, total_deod_volume: '1139.000000000000000000', sent_to_exchanges: '1107.000000000000000000', received_from_exchanges: '20.000000000000000000',
      exchange_transfer_count: 4, swap_buy_deod: '10.000000000000000000', swap_sell_deod: '2.000000000000000000', swap_count: 2, swap_usd_volume: '6.100000000000000000',
      largest_transfer: '1000.000000000000000000', largest_swap: '10.000000000000000000',
    });
    expect(p.exchanges.map((x) => [x.exchange, x.direction, x.total, x.transfers])).toEqual([
      ['mexc', 'IN', '107.000000000000000000', 2], ['mexc', 'OUT', '20.000000000000000000', 1], ['toobit', 'IN', '1000.000000000000000000', 1],
    ]);
    expect(p.swaps.map((x) => [x.version, x.side, x.deod, x.usd, x.swaps])).toEqual([['2', 'BUY', '10.000000000000000000', '5.000000000000000000', 1], ['3', 'SELL', '2.000000000000000000', '1.100000000000000000', 1]]);
    expect((await A.walletProfile(db, c)).swapsAsRecipientOnly).toBe(1);                         // a's first swap paid out to c
    expect(await A.walletProfile(db, '0x' + 'd'.repeat(40))).toMatchObject({ summary: null, exchanges: [], swaps: [], swapsAsRecipientOnly: 0 });
  });

  it('walletTimeline(): newest first across transfers and swaps, with paging', async () => {
    expect((await A.walletTimeline(db, a, 3, 0)).map((t) => [t.kind, t.tx_hash])).toEqual([['swap', T(14)], ['exchange', T(4)], ['exchange', T(3)]]);
    expect((await A.walletTimeline(db, a, 2, 1)).map((t) => t.tx_hash)).toEqual([T(4), T(3)]);
    expect(await A.walletTimeline(db, a, 100, 0)).toHaveLength(6);
    expect((await A.walletTimeline(db, a, 1, 0))[0]).toMatchObject({ venue: 'pancakeswap_v3', action: 'SELL', usd_value: '1.100000000000000000', counterparty: POOL_V3 });
  });

  it('search(): transaction hash, known and unknown address, junk', async () => {
    const tx = await A.search(db, T(1).toUpperCase().replace('0X', '0x'));
    expect(tx).toMatchObject({ type: 'tx' });
    expect((tx as { results: { kind: string; amount: string }[] }).results).toEqual([expect.objectContaining({ kind: 'flow', venue: 'mexc', action: 'IN', amount: '100.000000000000000000' })]);
    expect(await A.search(db, a)).toEqual({ type: 'address', known: true, address: a });
    expect(await A.search(db, '0x' + 'e'.repeat(40))).toMatchObject({ type: 'address', known: false });
    expect(await A.search(db, 'hello')).toEqual({ type: 'invalid' });
  });

  it('dataThrough() is the earliest checkpoint, and null before any sync', async () => {
    expect(await A.dataThrough(db)).toBeNull();
    await setSyncedUntil(db, '2026-10-22T00:00:00Z', ['pancakeswap_swaps']);
    await setSyncedUntil(db, '2026-10-21T00:00:00Z', ['exchange_transfers']);
    expect(await A.dataThrough(db)).toEqual(new Date('2026-10-21T00:00:00Z'));
  });

  it('syncStatus(): checkpoints, newest runs first, and the rejection count', async () => {
    await db.collection('dune_sync_state').updateOne({ _id: 'exchange_transfers' as never }, { $set: { credits_total: toDec128('1.37') } });
    await addSyncRuns(db, '2026-10-22T06:00:00Z', 'daily');
    await db.collection('ingest_rejections').insertOne({ _id: (await nextIds(db, 'ingest_rejections')) as never, query_name: 'x', reasons: ['r'], raw: {}, created_at: new Date() });
    const s = await A.syncStatus(db);
    expect(s.queries.map((q) => q.query_name)).toEqual(['exchange_transfers', 'pancakeswap_swaps']);
    expect(s.queries[0]).toMatchObject({ credits_total: '1.37', synced_until: new Date('2026-10-21T00:00:00Z'), error: null });
    expect(s.queries[1]!.credits_total).toBe('0');
    expect(s.recentRuns).toHaveLength(2);
    expect(s.recentRuns[0]!.id).toBeGreaterThan(s.recentRuns[1]!.id);
    expect(s.rejectedRows).toBe(1);
  });

  it('addressBook(): addresses with their exchange names, and the pools', async () => {
    await db.collection('exchange_addresses').insertOne({
      _id: (await nextIds(db, 'exchange_addresses')) as never, exchange: 'mexc', chain: 'bnb', address: MEXC_ADDR, label: 'MEXC', address_type: 'hot', source: 'config', verified: true, monitored: true, created_at: new Date(), updated_at: new Date(),
    });
    await db.collection('dex_pools').insertOne({ _id: POOL_V3 as never, address: POOL_V3, chain: 'bnb', version: '3', pair: 'DEOD/USDT', deod_address: 'x', quote_address: 'y', quote_symbol: 'USDT', quote_decimals: 18, fee_tier: 2500 });
    const book = await A.addressBook(db);
    expect(book.exchangeAddresses).toEqual([expect.objectContaining({ address: MEXC_ADDR, name: 'MEXC', verified: true, dune_label: null, notes: null })]);
    expect(book.pools).toEqual([{ address: POOL_V3, version: '3', pair: 'DEOD/USDT', fee_tier: 2500, quote_symbol: 'USDT', verification: null }]);
  });
});

describe.skipIf(!scratch)('alerts and the watchlist', () => {
  const db = scratch!.db;
  const EXPLORER = 'https://bscscan.com/tx/';

  async function alert(dedup: string, o: { rule?: string; exchange?: string | null; wallet?: string | null; sender?: string | null; time: string; tx?: string | null; amount?: string }) {
    await db.collection('alerts').insertOne({
      _id: (await nextIds(db, 'alerts')) as never, dedup_key: dedup, rule_code: o.rule ?? 'large_transfer', severity: 'high', source: 'exchange_flow', occurred_at: new Date(o.time),
      exchange: o.exchange ?? null, direction: 'IN', amount: toDec128(o.amount ?? '500000'), sender: o.sender ?? null, recipient: null, wallet_address: o.wallet ?? null,
      tx_hash: o.tx === undefined ? T(77) : o.tx, evt_index: 1, block_number: 5, details: { x: 1 }, created_at: new Date(),
    });
  }

  it('listAlerts(): newest first, filters, rule names and explorer links', async () => {
    await db.collection('alert_rules').insertMany([
      { _id: 'large_transfer' as never, code: 'large_transfer', kind: 'large_transfer', name: 'Large exchange transfer', enabled: true, severity: 'high', params: { min_amount: 500000 }, updated_at: new Date() },
      { _id: 'flow_spike' as never, code: 'flow_spike', kind: 'flow_spike', name: 'Unusual exchange flow', enabled: true, severity: 'medium', params: {}, updated_at: new Date() },
    ]);
    await alert('1', { exchange: 'mexc', wallet: a, time: '2026-10-20T00:00:00Z' });
    await alert('2', { rule: 'flow_spike', exchange: 'toobit', time: '2026-10-21T00:00:00Z', tx: null });
    await alert('3', { exchange: 'mexc', sender: b, time: '2026-10-19T00:00:00Z' });
    const all = await A.listAlerts(db, A.AlertFilter.parse({}), EXPLORER);
    expect(all.total).toBe(3);
    expect(all.rows[0]).toMatchObject({ rule_code: 'flow_spike', rule_name: 'Unusual exchange flow', explorer_url: null, amount: '500000.000000000000000000', details: { x: 1 } });
    expect(all.rows[1]!.explorer_url).toBe(`${EXPLORER}${T(77)}`);
    expect((await A.listAlerts(db, A.AlertFilter.parse({ rule: 'large_transfer' }), EXPLORER)).total).toBe(2);
    expect((await A.listAlerts(db, A.AlertFilter.parse({ exchange: 'toobit' }), EXPLORER)).total).toBe(1);
    expect((await A.listAlerts(db, A.AlertFilter.parse({ wallet: a }), EXPLORER)).total).toBe(1);   // matches wallet_address
    expect((await A.listAlerts(db, A.AlertFilter.parse({ wallet: b }), EXPLORER)).total).toBe(1);   // matches sender
    expect((await A.listAlerts(db, A.AlertFilter.parse({ limit: 1, offset: 2 }), EXPLORER)).rows).toHaveLength(1);
  });

  it('alertRules(): rules with how many alerts each raised, and the last scan time', async () => {
    await db.collection('alert_state').insertOne({ _id: 'exchange_flows' as never, name: 'exchange_flows', last_id: 5, updated_at: new Date('2026-10-22T06:00:00Z') });
    await db.collection('alert_state').insertOne({ _id: 'dex_swaps' as never, name: 'dex_swaps', last_id: 3, updated_at: new Date('2026-10-22T07:00:00Z') });
    const r = await A.alertRules(db);
    expect(r.rules.map((x) => [x.code, x.alerts])).toEqual([['flow_spike', 1], ['large_transfer', 2]]);
    expect(r.rules[1]!.latest_alert).toEqual(new Date('2026-10-20T00:00:00Z'));
    expect(r.lastScan).toEqual(new Date('2026-10-22T07:00:00Z'));
  });

  it('watchlist: add, update in place, count alerts, remove, and a full list refuses new wallets', async () => {
    const input = (address: string, extra: object = {}) => A.WatchInput.parse({ address, ...extra });
    const first = await A.upsertWatched(db, input(a.toUpperCase().replace('0X', '0x'), { label: ' Alice ', min_amount: '12.5' }));
    expect(first).toMatchObject({ address: a, label: 'Alice', watch: 'both', min_amount: '12.500000000000000000', enabled: true });
    await alert('w1', { rule: 'watched_wallet', wallet: a, time: '2026-10-21T00:00:00Z' });
    await db.collection('alert_rules').insertOne({ _id: 'watched_wallet' as never, code: 'watched_wallet', kind: 'watched_wallet', name: 'Watched wallet activity', enabled: true, severity: 'high', params: {}, updated_at: new Date() });
    const again = await A.upsertWatched(db, input(a, { watch: 'incoming' }));
    expect(again).toMatchObject({ label: null, watch: 'incoming', min_amount: '0' });
    expect(again!.created_at).toEqual(first!.created_at);                                       // updating does not make it "new"
    const list = await A.listWatched(db);
    expect(list.rows).toEqual([expect.objectContaining({ address: a, alerts: 1, watch: 'incoming' })]);
    expect(await A.removeWatched(db, a)).toBe(true);
    expect(await A.removeWatched(db, a)).toBe(false);

    for (let i = 0; i < A.MAX_WATCHED; i++) await A.upsertWatched(db, input('0x' + i.toString(16).padStart(40, '0')));
    expect(await A.upsertWatched(db, input(c))).toBeNull();                                     // full: refused
    expect(await A.upsertWatched(db, input('0x' + '0'.padStart(40, '0'), { label: 'edit' }))).toMatchObject({ label: 'edit' });   // but existing ones can still be edited
    expect((await A.listWatched(db)).rows).toHaveLength(A.MAX_WATCHED);
  });
});

describe('short periods follow the newest fetched data', () => {
  const now = new Date('2026-10-23T12:00:00Z');
  it('6h ends at the anchor when data is older than now; 7d and all do not move', () => {
    const anchor = new Date('2026-10-23T06:00:00Z');
    const w = A.resolveWindow({ range: '6h' }, now, anchor);
    expect([w.from!.toISOString(), w.to.toISOString()]).toEqual(['2026-10-23T00:00:00.000Z', '2026-10-23T06:00:00.000Z']);
    expect(A.resolveWindow({ range: '7d' }, now, anchor).to).toEqual(now);
    expect(A.resolveWindow({ range: 'all' }, now, anchor).to).toEqual(now);
  });
  it('without an anchor, or with a future one, it counts back from now', () => {
    expect(A.resolveWindow({ range: '6h' }, now, null).to).toEqual(now);
    expect(A.resolveWindow({ range: '6h' }, now, new Date('2026-10-24T00:00:00Z')).to).toEqual(now);
  });
  it('dataAnchor() is the end of the newest ok sync window', async () => {
    const db = scratch!.db;
    await addSyncRuns(db, '2026-10-22T06:00:00Z', 'daily');
    await db.collection('sync_runs').updateMany({}, { $set: { window_end: new Date('2026-10-22T06:00:00Z') } });
    await addSyncRuns(db, '2026-10-23T05:00:00Z', 'today');
    expect(await A.dataAnchor(db)).toEqual(new Date('2026-10-23T05:00:00Z'));
  });
});
