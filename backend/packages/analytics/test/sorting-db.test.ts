// Regression test: "sort by amount" must order by NUMBER. It once ordered by the text form of the amount ("9.97" ahead of "1270524.83"), so the
// Exchange flows and Swaps pages (and their CSV exports) listed the wrong transfers first. Runs on a THROWAWAY database; skipped when none is reachable.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addFlow, addSwap, createScratchDb } from '@deod/db';
import { FlowFilter, SwapFilter, listFlows, listSwaps, type Window } from '../src/index.js';

const scratch = await createScratchDb('deod_sort_test');
const w: Window = { from: null, to: new Date('2026-10-22T00:00:00Z'), range: 'all', bucket: 'day' };
const WALLET = '0x1111111111111111111111111111111111111111';
const AMOUNTS = ['9.97', '1270524.83', '99999', '100', '29158937.7564', '999985'];
const BIGGEST_FIRST = [29158937.7564, 1270524.83, 999985, 99999, 100, 9.97];

describe.skipIf(!scratch)('sorting by amount', () => {
  const db = scratch!.db;

  beforeAll(async () => {
    for (const a of AMOUNTS) {
      await addFlow(db, { exchange: 'mexc', direction: 'IN', wallet: WALLET, amount: a, time: '2026-10-20T00:00:00Z' });
      await addSwap(db, { side: 'SELL', trader: WALLET, amount: a, time: '2026-10-20T00:00:00Z' });
    }
  }, 60_000);

  afterAll(() => scratch?.drop());

  it('lists exchange transfers largest first by number', async () => {
    const r = await listFlows(db, w, FlowFilter.parse({ sort: 'amount', limit: 10 }));
    expect(r.rows.map((x) => Number(x.amount))).toEqual(BIGGEST_FIRST);
  });

  it('lists swaps largest first by number', async () => {
    const r = await listSwaps(db, w, SwapFilter.parse({ sort: 'amount', limit: 10 }));
    expect(r.rows.map((x) => Number(x.deod_amount))).toEqual(BIGGEST_FIRST);
  });

  it('still orders by time when asked to, and paging by amount does not skip or repeat rows', async () => {
    const byTime = await listFlows(db, w, FlowFilter.parse({ sort: 'time', limit: 10 }));
    expect(byTime.rows).toHaveLength(6);
    const page1 = await listFlows(db, w, FlowFilter.parse({ sort: 'amount', limit: 3, offset: 0 }));
    const page2 = await listFlows(db, w, FlowFilter.parse({ sort: 'amount', limit: 3, offset: 3 }));
    expect([...page1.rows, ...page2.rows].map((x) => Number(x.amount))).toEqual(BIGGEST_FIRST);
  });

  it('filters by minimum and maximum amount as numbers, and reports the matching total', async () => {
    const r = await listFlows(db, w, FlowFilter.parse({ min: '100', max: '999985', sort: 'amount' }));
    expect(r.total).toBe(3);                                                   // 100, 99999 and 999985: both bounds are inclusive
    expect(r.rows.map((x) => Number(x.amount))).toEqual([999985, 99999, 100]);
    const s = await listSwaps(db, w, SwapFilter.parse({ min: '1000000' }));
    expect(s.total).toBe(2);
  });

  it('returns amounts as exact decimal strings with 18 decimals, never in scientific notation', async () => {
    const r = await listFlows(db, w, FlowFilter.parse({ sort: 'amount', limit: 1 }));
    expect(r.rows[0]!.amount).toBe('29158937.756400000000000000');
    expect(r.rows[0]!.amount_raw).toBe('29158937756400000000000000');
  });
});
