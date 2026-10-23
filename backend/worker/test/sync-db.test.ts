// The sync's bookkeeping against a THROWAWAY database and a FAKE Dune: what is stored, what the checkpoint does, what the credits add up to, what
// happens on failure, and that two syncs can never run at once. Nothing is sent to Dune, Telegram or OpenAI and deod_monitor is never touched.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createScratchDb, monitoredExchangeAddresses, seedFromConfig, testTx, withLock } from '@deod/db';

// Harmless values, never an empty string: an empty variable would be ignored and the real ones from backend/.env would be used.
process.env.TELEGRAM_BOT_TOKEN = 'disabled-for-tests';
process.env.TELEGRAM_ACCESS_CODE = 'disabled-for-tests';
process.env.OPENAI_API_KEY = 'disabled-for-tests';
process.env.DUNE_API_KEY = 'disabled-for-tests';
const scratch = await createScratchDb('deod_sync_test');
if (scratch) process.env.MONGODB_URI = scratch.uri;          // getDb() inside the worker now points at the throwaway database

const dune = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[], credits: 0.25 as number | null, fail: null as Error | null, calls: 0, delayMs: 0 }));
vi.mock('@deod/dune', async (orig) => ({
  ...(await orig<typeof import('@deod/dune')>()),
  DuneClient: class {
    async runSql() {
      dune.calls++;
      if (dune.delayMs) await new Promise((r) => setTimeout(r, dune.delayMs));
      if (dune.fail) throw dune.fail;
      return { executionId: `exec-${dune.calls}`, columns: [], columnTypes: [], rows: dune.rows, creditsUsed: dune.credits };
    }
  },
}));

const sync = scratch ? await import('../src/sync.js') : null;
const WALLET = '0x1111111111111111111111111111111111111111';
let monitored = '';

const row = (n: number, time: string, amountRaw = '1000000000000000000', from = WALLET, to = monitored) => ({
  tx_hash: testTx(n + 7000), evt_index: 1, block_number: 1000 + n, block_time: time, from_address: from, to_address: to, amount_raw: amountRaw, tx_from: from,
});

describe.skipIf(!scratch)('daily sync bookkeeping', () => {
  const db = scratch!.db;
  const NOW = new Date('2026-10-23T05:00:00Z');                   // 2026-10-22 ended 5 hours ago, more than the 2 hour settle time

  beforeAll(async () => {
    await seedFromConfig(db);
    monitored = (await monitoredExchangeAddresses(db))[0]!.address;
    for (const q of sync!.QUERIES) await db.collection('dune_sync_state').insertOne({ _id: q as never, query_name: q, status: 'ok', synced_until: new Date('2026-10-21T00:00:00Z'), credits_total: 0 as never });
  });
  afterAll(() => scratch?.drop());

  it('fetches each finished day once, stores the rows, moves the checkpoint and adds up the credits', async () => {
    dune.rows = [row(1, '2026-10-21 08:41:03.000 UTC'), row(2, '2026-10-21 09:00:00.000 UTC', '2500000000000000000')];
    const results = await sync!.syncCompletedDays('exchange_transfers', NOW);
    expect(results).toHaveLength(2);                              // 21 Oct and 22 Oct
    expect(dune.calls).toBe(2);
    // The fake returns the same two rows for both days: the second day finds them already stored.
    expect(results.map((r) => [r.fetched, r.inserted, r.duplicate])).toEqual([[2, 2, 0], [2, 0, 2]]);
    expect(await db.collection('token_transfers').countDocuments()).toBe(2);

    const state = (await db.collection('dune_sync_state').findOne({ _id: 'exchange_transfers' as never }))!;
    expect(state.synced_until).toEqual(new Date('2026-10-23T00:00:00Z'));
    expect(state).toMatchObject({ status: 'ok', error: null, last_successful_execution: 'exec-2' });
    expect(state.last_block_time).toEqual(new Date('2026-10-21T09:00:00Z'));
    expect(Number(state.credits_total.toString())).toBeCloseTo(0.5, 10);

    const runs = await db.collection('sync_runs').find({ query_name: 'exchange_transfers' }).sort({ _id: 1 }).toArray();
    expect(runs.map((r) => [r.mode, r.status, r.rows_fetched, r.rows_inserted, r.rows_duplicate, r.rows_rejected])).toEqual([['daily', 'ok', 2, 2, 0, 0], ['daily', 'ok', 2, 0, 2, 0]]);
    expect(runs[0]).toMatchObject({ window_start: new Date('2026-10-21T00:00:00Z'), window_end: new Date('2026-10-22T00:00:00Z'), execution_id: 'exec-1' });
    expect(runs[0]!.credits.toString()).toBe('0.25');
    expect(runs[0]!.finished_at).toBeInstanceOf(Date);
  });

  it('does nothing, and makes no Dune call, when there is no new finished day', async () => {
    const before = dune.calls;
    expect(await sync!.syncCompletedDays('exchange_transfers', NOW)).toEqual([]);
    expect(dune.calls).toBe(before);
  });

  it('records rows that fail validation and still stores the good ones', async () => {
    dune.rows = [row(3, '2026-10-23 01:00:00.000 UTC'), { ...row(4, '2026-10-23 02:00:00.000 UTC'), amount_raw: '-5' }, { ...row(5, '2026-10-23 03:00:00.000 UTC'), tx_hash: 'nope' }];
    const r = await sync!.syncCompletedDays('exchange_transfers', new Date('2026-10-24T05:00:00Z'));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ fetched: 3, inserted: 1, rejected: 2 });
    const rejected = await db.collection('ingest_rejections').find().toArray();
    expect(rejected).toHaveLength(2);
    expect(rejected.every((x) => x.query_name === 'exchange_transfers' && x.reasons.length > 0)).toBe(true);
  });

  it('on a Dune failure: the run and the state say error, the checkpoint stays, and the next try starts at the same day', async () => {
    dune.fail = new Error('Dune is down');
    await expect(sync!.syncCompletedDays('exchange_transfers', new Date('2026-10-25T05:00:00Z'))).rejects.toThrow('Dune is down');
    dune.fail = null;
    const state = (await db.collection('dune_sync_state').findOne({ _id: 'exchange_transfers' as never }))!;
    expect(state).toMatchObject({ status: 'error', error: 'Dune is down' });
    expect(state.synced_until).toEqual(new Date('2026-10-24T00:00:00Z'));
    const last = (await db.collection('sync_runs').find().sort({ _id: -1 }).limit(1).toArray())[0]!;
    expect(last).toMatchObject({ status: 'error', error: 'Dune is down' });
    dune.rows = [];
    const retry = await sync!.syncCompletedDays('exchange_transfers', new Date('2026-10-25T05:00:00Z'));
    expect(retry.map((r) => r.fetched)).toEqual([0]);             // 24 Oct, the day that failed
    expect((await db.collection('dune_sync_state').findOne({ _id: 'exchange_transfers' as never }))).toMatchObject({ status: 'ok', error: null });
  });

  it('a re-run of an OLD window never moves the checkpoint backwards', async () => {
    const state = () => db.collection('dune_sync_state').findOne({ _id: 'exchange_transfers' as never }).then((s) => s!.synced_until as Date);
    const before = await state();
    await db.collection('dune_sync_state').updateOne({ _id: 'exchange_transfers' as never }, { $set: { backfill_from: null } });
    dune.rows = [];
    await sync!.backfill('exchange_transfers', new Date('2026-10-01T00:00:00Z'), new Date('2026-10-02T00:00:00Z'), 1);
    expect(await state()).toEqual(before);
  });

  it('"Update today" stores the unfinished day but never moves the daily checkpoint, and counts as one use', async () => {
    const through = async () => (await db.collection('dune_sync_state').findOne({ _id: 'exchange_transfers' as never }))!.synced_until as Date;
    const before = await through();
    dune.rows = [row(6, '2026-10-26 01:30:00.000 UTC')];
    const t = await sync!.syncToday(new Date('2026-10-26T02:00:00Z'));
    expect(t.inserted).toBe(1);                                   // the transfer; the swaps query returned the same row, which is not a valid swap
    expect(await through()).toEqual(before);
    expect(await db.collection('sync_runs').countDocuments({ mode: 'today', started_at: { $gte: new Date('2026-10-26T00:00:00Z') } })).toBe(2);
    expect(await sync!.todayUsage(new Date('2026-10-26T02:00:00Z'))).toMatchObject({ used: 1, remaining: 1 });
    // derived data was refreshed after the update
    expect(await db.collection('exchange_flows').countDocuments({ tx_hash: testTx(6 + 7000) })).toBe(1);
    expect(await db.collection('wallet_summary').countDocuments({ _id: WALLET as never })).toBe(1);
  });

  it('"Update today" is refused inside the cooldown, and after the daily limit, without calling Dune', async () => {
    const calls = dune.calls;
    await expect(sync!.syncToday(new Date('2026-10-26T02:03:00Z'))).rejects.toBeInstanceOf(sync!.SyncCooldownError);
    dune.rows = [];
    await sync!.syncToday(new Date('2026-10-26T03:00:00Z'));      // second use
    const afterSecond = dune.calls;
    await expect(sync!.syncToday(new Date('2026-10-26T04:00:00Z'))).rejects.toBeInstanceOf(sync!.SyncLimitError);
    expect(dune.calls).toBe(afterSecond);
    expect(afterSecond).toBeGreaterThan(calls);
    // a scheduled update has its own budget: it still runs
    await sync!.syncToday(new Date('2026-10-26T05:00:00Z'), 'auto');
    expect(await db.collection('sync_runs').countDocuments({ mode: 'today_auto' })).toBe(2);
  });

  it('two syncs can never run at the same time (the second is refused at once)', async () => {
    dune.delayMs = 300;
    dune.rows = [];
    const first = sync!.syncToday(new Date('2026-10-27T02:00:00Z'));
    await new Promise((r) => setTimeout(r, 100));
    await expect(sync!.syncToday(new Date('2026-10-27T09:00:00Z'))).rejects.toBeInstanceOf(sync!.SyncBusyError);
    await first;
    dune.delayMs = 0;
    // and the lock is free again afterwards
    expect(await withLock(db, 'sync', () => new Error('busy'), async () => 'free')).toBe('free');
  });
});
