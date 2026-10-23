// The MongoDB data layer against a THROWAWAY database: exact numbers, duplicate protection, derived flows, validation rules, the lock and the
// migration itself. Skipped (and reported as skipped) when no database server is reachable; deod_monitor is never touched.
import { afterAll, describe, expect, it } from 'vitest';
import { Decimal128 } from 'mongodb';
import {
  addExchanges, addFlow, addSwap, createScratchDb, databaseName, decStr, deriveExchangeFlows, insertSwaps, insertTransfers, migrate, monitoredExchangeAddresses, nextIds,
  recordRejections, refreshWalletSummary, seedFromConfig, STEPS, testTx, toDec128, toBound, withLock,
} from '../src/index.js';

describe('decimal numbers', () => {
  it('keep every digit of an 18-decimal amount', () => {
    expect(toDec128('29158937.756400000000000123').toString()).toBe('29158937.756400000000000123');
    expect(decStr(toDec128('0.000000000000000001'))).toBe('0.000000000000000001');      // Decimal128.toString() would print 1E-18: decStr never does
  });
  it('accept long runs of trailing zeros (scale is not precision)', () => {
    expect(() => toDec128('1.' + '0'.repeat(40))).not.toThrow();
  });
  it('refuse a value that needs more than 34 digits, instead of rounding it', () => {
    expect(() => toDec128('1' + '2'.repeat(40))).toThrow(/34/);
    expect(() => toDec128('0.' + '1'.repeat(40))).toThrow(/34/);
  });
  it('refuse text that is not a plain number', () => {
    for (const bad of ['', 'abc', '1e5', '1,5', '--1', '0x10']) expect(() => toDec128(bad)).toThrow();
  });
  it('print as plain strings padded to the old PostgreSQL scale, and zero as "0"', () => {
    expect(decStr(Decimal128.fromString('12.5'))).toBe('12.500000000000000000');
    expect(decStr(Decimal128.fromString('1E+3'))).toBe('1000.000000000000000000');       // a Decimal128 may carry an exponent; the output never does
    expect(decStr(Decimal128.fromString('0.017'), 30)).toBe('0.017000000000000000000000000000');
    expect(decStr(0)).toBe('0');
    expect(decStr(Decimal128.fromString('0.000'))).toBe('0');
    expect(decStr(5)).toBe('5.000000000000000000');
  });
  it('turn a user-supplied bound into something the database can compare', () => {
    expect(toBound(100).toString()).toBe('100');
    expect(toBound(1e40)).toBeInstanceOf(Decimal128);
  });
});

describe('database name', () => {
  it('is read from the connection string', () => {
    expect(databaseName('mongodb://127.0.0.1:27018/deod_monitor')).toBe('deod_monitor');
    expect(databaseName('mongodb://u:p@h1:27017,h2:27017/mydb?replicaSet=rs')).toBe('mydb');
    expect(databaseName('mongodb+srv://u:p@cluster.mongodb.net/prod?retryWrites=true')).toBe('prod');
    expect(databaseName('mongodb://127.0.0.1:27018')).toBe('deod_monitor');
  });
});

const scratch = await createScratchDb('deod_db_test');
const WALLET = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const DEOD = '0x3510fbbc13090f991ffa523527113a166161683e';

describe.skipIf(!scratch)('on a database', () => {
  const db = scratch!.db;
  afterAll(() => scratch?.drop());

  it('migrate() applied every step once and is a no-op the second time', async () => {
    const applied = (await db.collection('schema_migrations').find().toArray()).map((r) => r._id);
    expect(applied).toEqual(STEPS.map((s) => s.name));
    expect(await migrate(db)).toEqual([]);
  });

  it('migrate() survives two processes starting at the same moment', async () => {
    const fresh = await createScratchDb('deod_db_race');
    try {
      await fresh!.db.collection('schema_migrations').deleteMany({});
      const results = await Promise.allSettled([migrate(fresh!.db), migrate(fresh!.db), migrate(fresh!.db)]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
    } finally { await fresh?.drop(); }
  });

  it('seedFromConfig() creates exchanges, monitored addresses and pools, and a second run changes nothing', async () => {
    await seedFromConfig(db);
    const a = await monitoredExchangeAddresses(db);
    expect(a.length).toBeGreaterThanOrEqual(5);
    expect(new Set(a.map((x) => x.address)).size).toBe(a.length);
    const counts = async () => [await db.collection('exchanges').countDocuments(), await db.collection('exchange_addresses').countDocuments(), await db.collection('dex_pools').countDocuments()];
    const before = await counts();
    await seedFromConfig(db);
    expect(await counts()).toEqual(before);
    expect(await db.collection('dex_pools').countDocuments({ version: '2' })).toBe(1);
    expect(await db.collection('dex_pools').countDocuments({ version: '3' })).toBe(1);
  });

  it('seedFromConfig() leaves an address added by an admin alone', async () => {
    const [first] = await monitoredExchangeAddresses(db);
    await db.collection('exchange_addresses').updateOne({ address: first!.address }, { $set: { source: 'admin', address_type: 'hand_edited', monitored: false } });
    await seedFromConfig(db);
    expect(await db.collection('exchange_addresses').findOne({ address: first!.address })).toMatchObject({ source: 'admin', address_type: 'hand_edited', monitored: false });
    await db.collection('exchange_addresses').updateOne({ address: first!.address }, { $set: { source: 'config', monitored: true } });
  });

  const tx = (n: number) => testTx(n + 5000);
  const transfer = (n: number, from: string, to: string, raw: string) => ({ txHash: tx(n), evtIndex: 1, blockNumber: 100 + n, blockTime: '2026-10-01T00:00:00.000Z', fromAddress: from, toAddress: to, amountRaw: raw, txFrom: null });

  it('insertTransfers() stores exact amounts, counts only new rows and skips duplicates (also inside one batch)', async () => {
    const [ex] = await monitoredExchangeAddresses(db);
    const rows = [transfer(1, WALLET, ex!.address, '1000000000000000000000123'), transfer(2, ex!.address, OTHER, '5'), transfer(2, ex!.address, OTHER, '5')];
    expect(await insertTransfers(rows, DEOD, 18, db)).toBe(2);
    expect(await insertTransfers(rows, DEOD, 18, db)).toBe(0);
    const stored = await db.collection('token_transfers').findOne({ tx_hash: tx(1) });
    expect(stored).toMatchObject({ amount_raw: '1000000000000000000000123', chain: 'bnb' });
    expect(stored!.amount.toString()).toBe('1000000.000000000000000123');
    expect(await db.collection('token_transfers').countDocuments()).toBe(2);
  });

  it('the database itself refuses malformed rows (validation rules)', async () => {
    const good = (await db.collection('token_transfers').findOne({ tx_hash: tx(1) }))!;
    const { _id, ...rest } = good;
    const attempts: Record<string, unknown>[] = [
      { ...rest, chain: 'eth' }, { ...rest, tx_hash: '0x123' }, { ...rest, amount_raw: '-5' }, { ...rest, amount_raw: '1.5' },
      { ...rest, amount: 5 }, { ...rest, block_number: 0 }, { ...rest, evt_index: -1 },
    ];
    for (const [i, doc] of attempts.entries()) {
      await expect(db.collection('token_transfers').insertOne({ ...doc, tx_hash: doc.tx_hash === '0x123' ? '0x123' : tx(900 + i), _id: (await nextIds(db, 'token_transfers')) as never }), `attempt ${i}`).rejects.toThrow();
    }
    expect(await db.collection('token_transfers').countDocuments()).toBe(2);
  });

  it('deriveExchangeFlows() makes IN and OUT rows, ignores unrelated transfers and is idempotent', async () => {
    const [ex] = await monitoredExchangeAddresses(db);
    await insertTransfers([transfer(3, OTHER, WALLET, '7')], DEOD, 18, db);              // between two ordinary wallets: no flow
    expect(await deriveExchangeFlows(db)).toBe(2);
    expect(await deriveExchangeFlows(db)).toBe(0);
    const flows = await db.collection('exchange_flows').find().sort({ tx_hash: 1 }).toArray();
    expect(flows.map((f) => [f.direction, f.wallet_address, f.exchange_address])).toEqual([['IN', WALLET, ex!.address], ['OUT', OTHER, ex!.address]]);
    expect(flows[0]!.amount.toString()).toBe('1000000.000000000000000123');
  });

  it('deriveExchangeFlows() gives two rows to a transfer between two monitored addresses, and none to a self-transfer', async () => {
    const [a, b] = await monitoredExchangeAddresses(db);
    await insertTransfers([transfer(4, a!.address, b!.address, '9'), transfer(5, a!.address, a!.address, '9')], DEOD, 18, db);
    expect(await deriveExchangeFlows(db)).toBe(2);
    const both = await db.collection('exchange_flows').find({ tx_hash: tx(4) }).toArray();
    expect(both.map((f) => f.direction).sort()).toEqual(['IN', 'OUT']);
    expect(await db.collection('exchange_flows').countDocuments({ tx_hash: tx(5) })).toBe(0);
  });

  it('deriveExchangeFlows() picks up history for an address that starts being monitored later', async () => {
    const [ex] = await monitoredExchangeAddresses(db);
    await db.collection('exchange_addresses').updateOne({ address: ex!.address }, { $set: { monitored: false } });
    await db.collection('exchange_flows').deleteMany({ exchange_address: ex!.address });
    expect(await deriveExchangeFlows(db)).toBe(0);
    await db.collection('exchange_addresses').updateOne({ address: ex!.address }, { $set: { monitored: true } });
    expect(await deriveExchangeFlows(db)).toBeGreaterThanOrEqual(2);
  });

  it('insertSwaps() maps BUY and SELL to the right tokens, exact amounts and the USD peg', async () => {
    const quote = new Map([['0x55d398326f99059ff775485246999027b3197955', { decimals: 18, usdPeg: true, symbol: 'USDT' }]]);
    const base = { version: '2' as const, poolAddress: '0xd693c42610bd30e63b0a68a25918445a5f9a1d20', evtIndex: 1, blockNumber: 1, blockTime: '2026-10-01T00:00:00.000Z', traderAddress: WALLET, recipientAddress: null, txTo: null, quoteTokenAddress: '0x55d398326f99059ff775485246999027b3197955' };
    const rows = [
      { ...base, txHash: tx(10), side: 'BUY' as const, deodAmountRaw: '2000000000000000000', quoteAmountRaw: '34000000000000000', price: '0.017' },
      { ...base, txHash: tx(11), side: 'SELL' as const, deodAmountRaw: '3000000000000000000', quoteAmountRaw: '51000000000000000', price: '0.017' },
    ];
    expect(await insertSwaps(rows, { deodDecimals: 18, quote }, db)).toBe(2);
    expect(await insertSwaps(rows, { deodDecimals: 18, quote }, db)).toBe(0);
    const buy = (await db.collection('dex_swaps').findOne({ tx_hash: tx(10) }))!;
    expect(buy).toMatchObject({ token_out: DEOD, amount_out_raw: '2000000000000000000', usd_basis: 'usdt_peg' });
    expect(buy.token_in).toBe('0x55d398326f99059ff775485246999027b3197955');
    expect(buy.deod_amount.toString()).toBe('2');
    expect(buy.usd_value.toString()).toBe('0.034');
    const sell = (await db.collection('dex_swaps').findOne({ tx_hash: tx(11) }))!;
    expect(sell).toMatchObject({ token_in: DEOD, amount_in_raw: '3000000000000000000' });
  });

  it('recordRejections() keeps the reasons and the raw row', async () => {
    await recordRejections('exchange_transfers', 'exec1', [{ reasons: ['invalid tx_hash'], raw: { tx_hash: 'zzz', amount_raw: '5' } }], db);
    expect(await db.collection('ingest_rejections').findOne({})).toMatchObject({ query_name: 'exchange_transfers', execution_id: 'exec1', reasons: ['invalid tx_hash'], raw: { tx_hash: 'zzz' } });
  });

  it('refreshWalletSummary() adds up each wallet across exchange flows and swaps, and can be repeated', async () => {
    const fresh = await createScratchDb('deod_db_wallets');
    try {
      const d = fresh!.db;
      await addFlow(d, { exchange: 'mexc', direction: 'IN', wallet: WALLET, amount: '100', time: '2026-10-01T00:00:00Z', tx: testTx(1) });
      await addFlow(d, { exchange: 'mexc', direction: 'OUT', wallet: WALLET, amount: '40.5', time: '2026-10-02T00:00:00Z', tx: testTx(2) });
      await addSwap(d, { side: 'BUY', trader: WALLET, amount: '10', time: '2026-10-03T00:00:00Z', tx: testTx(3), price: '0.5' });
      await addSwap(d, { side: 'SELL', trader: WALLET, amount: '4', time: '2026-10-04T00:00:00Z', tx: testTx(1), price: '0.5' });     // same hash as the first flow: one transaction
      await addFlow(d, { exchange: 'mexc', direction: 'IN', wallet: OTHER, amount: '1', time: '2026-10-05T00:00:00Z', tx: testTx(9) });
      await refreshWalletSummary(d);
      await refreshWalletSummary(d);
      expect(await d.collection('wallet_summary').countDocuments()).toBe(2);
      const w = (await d.collection('wallet_summary').findOne({ _id: WALLET as never }))!;
      expect(w).toMatchObject({ transaction_count: 3, exchange_transfer_count: 2, swap_count: 2 });
      expect(decStr(w.total_deod_volume)).toBe('154.500000000000000000');
      expect(decStr(w.sent_to_exchanges)).toBe('100.000000000000000000');
      expect(decStr(w.received_from_exchanges)).toBe('40.500000000000000000');
      expect(decStr(w.swap_buy_deod)).toBe('10.000000000000000000');
      expect(decStr(w.swap_sell_deod)).toBe('4.000000000000000000');
      expect(decStr(w.swap_usd_volume)).toBe('7.000000000000000000');
      expect(decStr(w.largest_transfer)).toBe('100.000000000000000000');
      expect(decStr(w.largest_swap)).toBe('10.000000000000000000');
      expect(w.first_seen).toEqual(new Date('2026-10-01T00:00:00Z'));
      expect(w.last_seen).toEqual(new Date('2026-10-04T00:00:00Z'));
      const o = (await d.collection('wallet_summary').findOne({ _id: OTHER as never }))!;
      expect(o).toMatchObject({ swap_count: 0, largest_swap: null });
    } finally { await fresh?.drop(); }
  });

  it('nextIds() hands out consecutive numbers that are never reused, even in parallel', async () => {
    const blocks = await Promise.all([1, 2, 3, 4, 5].map(() => nextIds(db, 'test_seq', 10)));
    const ids = blocks.flatMap((first) => Array.from({ length: 10 }, (_, k) => first + k));
    expect(new Set(ids).size).toBe(50);
    expect(Math.min(...ids)).toBe(1);
    expect(Math.max(...ids)).toBe(50);
  });

  it('withLock() lets one holder in, refuses the second, and frees the lock afterwards (also after an error)', async () => {
    const busy = () => new Error('busy');
    let inside = false;
    await withLock(db, 'test-lock', busy, async () => {
      inside = true;
      await expect(withLock(db, 'test-lock', busy, async () => 'never')).rejects.toThrow('busy');
    });
    expect(inside).toBe(true);
    await expect(withLock(db, 'test-lock', busy, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await withLock(db, 'test-lock', busy, async () => 'ok')).toBe('ok');
  });

  it('withLock() takes over a lock whose lease has run out (a crashed process)', async () => {
    await db.collection('locks').replaceOne({ _id: 'stale' as never }, { owner: 'dead-process', acquired_at: new Date(0), expires_at: new Date(Date.now() - 1000) }, { upsert: true });
    expect(await withLock(db, 'stale', () => new Error('busy'), async () => 'took over')).toBe('took over');
  });

  it('only one of many simultaneous withLock() callers gets in', async () => {
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => withLock(db, 'race', () => new Error('busy'), async () => { await new Promise((r) => setTimeout(r, 150)); return 'in'; })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(7);
  });

  it('exchanges added by tests can be listed alongside the seeded ones', async () => {
    await addExchanges(db, { zzz_test: 'ZZZ' });
    expect(await db.collection('exchanges').countDocuments({ slug: 'zzz_test' })).toBe(1);
  });
});
