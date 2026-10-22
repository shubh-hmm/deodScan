import { describe, expect, it } from 'vitest';
import { buildSummary, compact, periodLabel, previousWindow, type OverviewData, type SummaryInput } from '../src/summary.js';

const TX = `0x${'ab'.repeat(32)}`;
const T = (s: string) => new Date(s);

const ex = (exchange: string, name: string, inflow: string, outflow: string, deposits: number, withdrawals: number) => ({
  exchange, name, inflow, outflow, net: String(Number(inflow) - Number(outflow)), deposits, withdrawals, unique_wallets: deposits + withdrawals,
});
const overview = (o: Partial<OverviewData> = {}): OverviewData => ({
  exchanges: [
    ex('mexc', 'MEXC', '399392.08', '2675747.79', 20, 8), ex('toobit', 'Toobit', '11456', '1431070.49', 3, 5),
    ex('xt', 'XT', '1113757.16', '10', 27, 1), ex('bingx', 'BingX', '0', '0', 0, 0),
  ],
  totals: { inflow: '1694873.88', outflow: '4205898.36', net: '-2511024.48', uniqueWallets: 268, exchangeTransfers: 248 },
  pancakeswap: {
    deod_volume: '3901365.52', buy_deod: '1900000', sell_deod: '2001365.52', usd_volume: '71451.84', swaps: 2829, buys: 1500, sells: 1329,
    unique_wallets: 229, largest_swap_deod: '94355.145', last_price: '0.017130544031613', last_swap_time: '2026-10-22T04:38:43Z',
  },
  ...o,
});
const input = (o: Partial<SummaryInput> = {}): SummaryInput => ({
  window: { from: T('2026-10-15T10:40:00Z'), to: T('2026-10-22T10:40:00Z'), range: '7d' },
  current: overview(), previous: overview({ totals: { inflow: '847436.94', outflow: '4205898.36', net: '0', uniqueWallets: 100, exchangeTransfers: 1 } }),
  largest: { exchange: 'mexc', direction: 'OUT', amount: '2499950', block_time: '2026-10-15T10:39:00Z', tx_hash: TX },
  alertCounts: { large_transfer: 3, large_swap: 2 }, dataThrough: T('2026-10-22T00:00:00Z'),
  firstTransfer: [{ name: 'MEXC', first: T('2026-01-16') }, { name: 'XT', first: T('2026-10-15') }, { name: 'Toobit', first: T('2026-01-19') }],
  ...o,
});
const section = (s: ReturnType<typeof buildSummary>, title: string) => s.sections.find((x) => x.title === title);

describe('compact numbers', () => {
  it('writes sizes the way the dashboard does and never rounds a figure into a different magnitude', () => {
    expect(compact('2040000')).toBe('2.04M');
    expect(compact('94355.145')).toBe('94.36K');
    expect(compact('999999')).toBe('1000K');                  // never "1M" from 999,999: below the next unit stays in thousands
    expect(compact('812.4')).toBe('812');
    expect(compact('5.5')).toBe('5.5');
    expect(compact('0')).toBe('0');
    expect(compact('-1500000')).toBe('1.5M');                 // sign is written by the sentence, not the number
    expect(compact('1234567890123')).toBe('1.23T');
  });
});

describe('period wording', () => {
  it('names each period in plain words', () => {
    const w = (range: string) => ({ from: T('2026-10-15'), to: T('2026-10-22'), range });
    expect(periodLabel(w('24h'))).toBe('the last 24 hours');
    expect(periodLabel(w('7d'))).toBe('the last 7 days');
    expect(periodLabel({ from: null, to: T('2026-10-22'), range: 'all' })).toBe('all recorded history');
    expect(periodLabel(w('custom'))).toBe('2026-10-15 to 2026-10-22');
  });
  it('compares with the previous period of the same length, and has none for all time', () => {
    const p = previousWindow({ from: T('2026-10-15T00:00:00Z'), to: T('2026-10-22T00:00:00Z'), range: '7d', bucket: 'day' })!;
    expect(p.from!.toISOString()).toBe('2026-10-08T00:00:00.000Z');
    expect(p.to.toISOString()).toBe('2026-10-15T00:00:00.000Z');
    expect(previousWindow({ from: null, to: T('2026-10-22'), range: 'all', bucket: 'day' })).toBeNull();
  });
});

describe('the summary text', () => {
  it('states the totals and the direction of the net flow exactly as the dashboard shows them', () => {
    const s = buildSummary(input());
    expect(s.period).toBe('the last 7 days');
    expect(s.headline).toContain('In the last 7 days, 268 wallets moved DEOD');
    expect(s.headline).toContain('1.69M DEOD was deposited to exchanges and 4.21M DEOD withdrawn');
    expect(s.headline).toContain('net outflow of 2.51M DEOD (wallets took out more than they sent)');
    const inflow = buildSummary(input({ current: overview({ totals: { inflow: '5000000', outflow: '1000000', net: '4000000', uniqueWallets: 10, exchangeTransfers: 4 } }) }));
    expect(inflow.headline).toContain('net inflow of 4M DEOD (wallets sent more than they took out)');
  });

  it('lists every active exchange with its deposits, withdrawals and net, busiest first, and names the quiet ones', () => {
    const lines = section(buildSummary(input()), 'Exchanges')!.lines;
    expect(lines[0]).toBe('MEXC: 399.39K DEOD in (20 deposits), 2.68M DEOD out (8 withdrawals), net -2.28M.');
    expect(lines).toContain('XT: 1.11M DEOD in (27 deposits), 10 DEOD out (1 withdrawal), net +1.11M.');
    expect(lines).toContain('Largest inflow: XT (1.11M DEOD).');
    expect(lines).toContain('Largest outflow: MEXC (2.68M DEOD).');
    expect(lines).toContain('No activity: BingX.');
    expect(lines.findIndex((l) => l.startsWith('MEXC'))).toBeLessThan(lines.findIndex((l) => l.startsWith('Toobit')));
  });

  it('reports the largest single transfer with its transaction hash', () => {
    const l = section(buildSummary(input()), 'Largest single transfer')!.lines[0]!;
    expect(l).toBe(`2.5M DEOD withdrawn from MEXC at 2026-10-15 10:39 UTC (transaction ${TX}).`);
  });

  it('summarises PancakeSwap, including net buying or selling and the last price', () => {
    const lines = section(buildSummary(input()), 'PancakeSwap')!.lines;
    expect(lines[0]).toBe('2,829 swaps (1,500 buys, 1,329 sells) by 229 wallets, 3.9M DEOD (about $71.45K) in total.');
    expect(lines[1]).toBe('Buys 1.9M DEOD against sells 2M DEOD: net selling of 101.37K DEOD.');
    expect(lines).toContain('Largest swap: 94.36K DEOD.');
    expect(lines).toContain('Last recorded trade price: $0.01713 at 2026-10-22 04:38 UTC.');
    const buying = buildSummary(input({ current: overview({ pancakeswap: { ...overview().pancakeswap, buy_deod: '3000000', sell_deod: '1000000' } }) }));
    expect(section(buying, 'PancakeSwap')!.lines[1]).toContain('net buying of 2M DEOD');
  });

  it('says so plainly when there were no swaps or no activity at all', () => {
    const none = buildSummary(input({
      current: overview({ exchanges: [ex('mexc', 'MEXC', '0', '0', 0, 0)], totals: { inflow: '0', outflow: '0', net: '0', uniqueWallets: 0, exchangeTransfers: 0 },
        pancakeswap: { ...overview().pancakeswap, swaps: 0, buys: 0, sells: 0, deod_volume: '0', buy_deod: '0', sell_deod: '0', unique_wallets: 0 } }),
      largest: null,
    }));
    expect(none.headline).toBe('No DEOD activity is recorded for the last 7 days.');
    expect(section(none, 'PancakeSwap')!.lines).toEqual(['No swaps recorded in this period.']);
    expect(section(none, 'Largest single transfer')).toBeUndefined();
    expect(section(none, 'Compared with the previous period of the same length')).toBeUndefined();
  });

  it('compares with the previous period using plain words, and leaves it out for all time', () => {
    const c = section(buildSummary(input()), 'Compared with the previous period of the same length')!.lines[0]!;
    expect(c).toBe('deposits up 100%, withdrawals no change, swaps no change.');
    expect(section(buildSummary(input({ previous: null })), 'Compared with the previous period of the same length')).toBeUndefined();
    const down = buildSummary(input({ previous: overview({ totals: { inflow: '3389747.76', outflow: '0', net: '0', uniqueWallets: 1, exchangeTransfers: 1 } }) }));
    expect(section(down, 'Compared with the previous period of the same length')!.lines[0]).toContain('deposits down 50%');
    expect(section(down, 'Compared with the previous period of the same length')!.lines[0]).toContain('withdrawals from nothing in the previous period');
  });

  it('reports alerts by kind, says when there were none, and skips the section when alerts are unavailable', () => {
    expect(section(buildSummary(input()), 'Alerts')!.lines[0]).toBe('5 alerts raised: 3 large transfers, 2 large swaps.');
    expect(section(buildSummary(input({ alertCounts: { flow_spike: 1 } })), 'Alerts')!.lines[0]).toBe('1 alert raised: 1 unusual exchange flow.');
    expect(section(buildSummary(input({ alertCounts: {} })), 'Alerts')!.lines[0]).toBe('No alerts were raised in this period.');
    expect(section(buildSummary(input({ alertCounts: null })), 'Alerts')).toBeUndefined();
  });
});

describe('what the summary admits it cannot see', () => {
  it('always says the data is synced once per finished day and how far it goes', () => {
    const n = buildSummary(input()).notes;
    expect(n[0]).toContain('latest fully synced day ends at 2026-10-22 00:00 UTC');
    expect(n.at(-1)).toContain('only transfers to and from the monitored exchange addresses');
  });
  it('warns when the whole period is later than the synced data', () => {
    const n = buildSummary(input({ window: { from: T('2026-10-22T08:00:00Z'), to: T('2026-10-22T10:00:00Z'), range: '6h' } })).notes;
    expect(n.some((x) => x.includes('later than the last synced data'))).toBe(true);
  });
  it('says when there is no data at all', () => {
    expect(buildSummary(input({ dataThrough: null })).notes[0]).toBe('No sync has completed yet, so there is no data.');
  });
  it('names exchanges whose recorded history starts much later than the others', () => {
    const all = buildSummary(input({ window: { from: null, to: T('2026-10-22T10:40:00Z'), range: 'all' } })).notes;
    expect(all.some((x) => x.includes('XT (2026-10-15)') && !x.includes('MEXC'))).toBe(true);
    const week = buildSummary(input()).notes;                                          // XT started inside this 7-day window: nothing to warn about
    expect(week.some((x) => x.includes('history starts later'))).toBe(false);
  });
});

describe('plain text copy', () => {
  it('contains the headline, every section line and every note, and nothing else', () => {
    const s = buildSummary(input());
    for (const l of [s.headline, ...s.sections.flatMap((x) => [x.title, ...x.lines.map((y) => `- ${y}`)]), ...s.notes.map((n) => `- ${n}`)]) expect(s.text).toContain(l);
    expect(s.text.startsWith(s.headline)).toBe(true);
  });
  it('never calls anyone a whale, bot or insider', () => {
    expect(buildSummary(input()).text.toLowerCase()).not.toMatch(/whale|insider|\bbot\b/);
  });
});
