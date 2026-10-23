// summarize() against a THROWAWAY database: the real queries behind the dashboard summary. Skipped (and reported as skipped) when no database
// server is reachable; deod_monitor is never touched.
import { afterAll, describe, expect, it } from 'vitest';
import { addExchanges, addFlow, createScratchDb, setSyncedUntil, toDec128 } from '@deod/db';
import { summarize } from '../src/summary.js';
import type { Window } from '../src/index.js';

const scratch = await createScratchDb('deod_summary_test');
const w = (from: string, to: string, range = '7d'): Window => ({ from: new Date(from), to: new Date(to), range: range as Window['range'], bucket: 'day' });
const WALLET = '0x1111111111111111111111111111111111111111';

describe.skipIf(!scratch)('summary from the database', () => {
  const db = scratch!.db;
  const flow = (exchange: string, direction: 'IN' | 'OUT', amount: string, time: string) => addFlow(db, { exchange, direction, amount, time, wallet: WALLET });

  afterAll(() => scratch?.drop());

  it('has its fixtures', async () => {
    await addExchanges(db, { mexc: 'MEXC', toobit: 'Toobit' });
    await setSyncedUntil(db, '2026-10-22T00:00:00Z');
  });

  it('picks the largest transfer by NUMBER, not by text ("9.97" is not bigger than "1270524.83")', async () => {
    await flow('mexc', 'IN', '9.97', '2026-10-20T10:00:00Z');
    await flow('mexc', 'IN', '99999', '2026-10-20T11:00:00Z');
    const big = await flow('toobit', 'OUT', '1270524.83', '2026-10-18T15:28:00Z');
    await flow('mexc', 'OUT', '5000', '2026-10-21T09:00:00Z');
    const s = await summarize(db, w('2026-10-15T10:40:00Z', '2026-10-22T10:40:00Z'));
    const line = s.sections.find((x) => x.title === 'Largest single transfer')!.lines[0]!;
    expect(line).toContain('1.27M DEOD withdrawn from Toobit');
    expect(line).toContain(big);
  });

  it('adds up exactly what the dashboard overview adds up', async () => {
    const s = await summarize(db, w('2026-10-15T10:40:00Z', '2026-10-22T10:40:00Z'));
    // IN: 9.97 + 99999 = 100,008.97 ; OUT: 1,270,524.83 + 5,000 = 1,275,524.83 ; net outflow 1,175,515.86
    expect(s.headline).toContain('100.01K DEOD was deposited to exchanges and 1.28M DEOD withdrawn');
    expect(s.headline).toContain('net outflow of 1.18M DEOD');
    expect(s.sections.find((x) => x.title === 'Exchanges')!.lines).toContain('Toobit: 0 DEOD in (0 deposits), 1.27M DEOD out (1 withdrawal), net -1.27M.');
    expect(s.sections.find((x) => x.title === 'PancakeSwap')!.lines).toEqual(['No swaps recorded in this period.']);
  });

  it('only counts the chosen period, compares with the one before it, and reports alerts', async () => {
    await flow('mexc', 'IN', '40000', '2026-10-10T10:00:00Z');                          // previous 7 days only
    await db.collection('alert_rules').insertOne({ _id: 'large_transfer' as never, code: 'large_transfer', kind: 'large_transfer', name: 'Large exchange transfer', enabled: true, severity: 'high', params: {} });
    await db.collection('alerts').insertMany([
      { _id: 1 as never, dedup_key: 'a', rule_code: 'large_transfer', severity: 'high', source: 'exchange_flow', occurred_at: new Date('2026-10-18T15:28:00Z'), amount: toDec128('1270524.83') },
      { _id: 2 as never, dedup_key: 'b', rule_code: 'large_transfer', severity: 'high', source: 'exchange_flow', occurred_at: new Date('2026-10-01T00:00:00Z'), amount: toDec128('5') },
    ]);
    const s = await summarize(db, w('2026-10-15T10:40:00Z', '2026-10-22T10:40:00Z'));
    expect(s.sections.find((x) => x.title === 'Alerts')!.lines[0]).toBe('1 alert raised: 1 large transfer.');
    expect(s.sections.find((x) => x.title === 'Compared with the previous period of the same length')!.lines[0]).toContain('deposits up 150%');   // 100,008.97 vs 40,000
  });

  it('describes a period with no data honestly, and notes how far the data goes', async () => {
    const s = await summarize(db, w('2026-10-22T08:00:00Z', '2026-10-22T10:00:00Z', '6h'));
    expect(s.headline).toBe('No DEOD activity is recorded for the last 6 hours.');
    expect(s.notes.some((x) => x.includes('later than the last synced data'))).toBe(true);
  });

  it('works for all time, which has no previous period', async () => {
    const s = await summarize(db, { from: null, to: new Date('2026-10-22T10:40:00Z'), range: 'all', bucket: 'day' });
    expect(s.period).toBe('all recorded history');
    expect(s.sections.find((x) => x.title === 'Compared with the previous period of the same length')).toBeUndefined();
  });
});
