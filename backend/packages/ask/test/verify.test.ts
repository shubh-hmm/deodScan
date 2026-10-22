import { describe, expect, it } from 'vitest';
import { collectFigures, extractFigures, verifyAnswer } from '../src/verify.js';

const data = {
  totals: { inflow: '2041225.566573879613827947', outflow: '1770236.97', net: '270988.59', uniqueWallets: 272 },
  exchanges: [{ name: 'XT', inflow: '1113757.164166878821', deposits: 25 }, { name: 'Toobit', outflow: '1524100.5' }],
  summary: 'deposits up 241.2%, withdrawals down 53.1%. Largest swap: 94.36K DEOD. Last price $0.01713 at 2026-10-22 04:38 UTC (transaction 0x15ee94773afbf63e9824b231ee9d7ad20a09d16512057225778efedeac46c7fc).',
  swaps: 2845,
};
const allowed = collectFigures(data);
const check = (answer: string, extra = '') => verifyAnswer(answer, [...allowed, ...extractFigures(extra)]);

describe('reading figures out of text', () => {
  it('understands thousands separators, decimals, suffixes and dollars, with the rounding they were shown with', () => {
    const f = extractFigures('1,270,524.83 DEOD, 2.04M, 94.36K and $0.01713');
    expect(f.map((x) => x.value.toString())).toEqual(['1270524.83', '2040000', '94360', '0.01713']);
    expect(f.map((x) => x.tol.toString())).toEqual(['0.005', '5000', '5', '0.000005']);
  });
  it('ignores things that only look like numbers: addresses, hashes, dates, times, versions, list numbering', () => {
    const f = extractFigures('1. On 2026-10-22 at 04:38 UTC the V3 pool at 0x185d73ec966d464a40372cd7e737bb68b0b95f1f sent it in 0xabc123.');
    expect(f).toEqual([]);
  });
  it('treats small whole numbers and years as ordinary words when checking an answer, but not other figures', () => {
    expect(extractFigures('top 5 wallets in 30 days of 2026', { skipSmall: true })).toEqual([]);
    expect(extractFigures('5 K', { skipSmall: true }).length).toBe(1);        // with a suffix it is a figure
    expect(extractFigures('$5 and 5.5 and 1,000 and 250', { skipSmall: true }).map((x) => x.raw)).toEqual(['$5', '5.5', '1,000', '250']);
  });
  it('collects the numbers from a whole tool result, including numbers written inside text', () => {
    const v = collectFigures(data).map((x) => x.value.toString());
    expect(v).toContain('272');
    expect(v).toContain('2041225.566573879613827947');
    expect(v).toContain('241.2');
    expect(v).toContain('94360');
  });
});

describe('checking an answer against the data', () => {
  it('accepts figures that are in the data, shown exactly or rounded the way people round', () => {
    expect(check('Deposits were 2.04M DEOD and withdrawals 1.77M DEOD, a net inflow of 270.99K DEOD.').ok).toBe(true);
    expect(check('XT received 1,113,757.16 DEOD in 25 deposits.').ok).toBe(true);
    expect(check('There were 2,845 swaps and 272 wallets.').ok).toBe(true);
    expect(check('Toobit withdrew about 1.5M DEOD.').ok).toBe(true);                      // 1.5M covers 1.45M-1.55M
    expect(check('Deposits are up 241.2% and the last price was $0.01713.').ok).toBe(true);
  });
  it('rejects a figure that is not in the data, and says which one', () => {
    const r = check('Deposits were 2.04M DEOD but withdrawals were 9.99M DEOD.');
    expect(r.ok).toBe(false);
    expect(r.unverified).toEqual(['9.99M']);
  });
  it('rejects a rounding that is too generous and a computed number', () => {
    expect(check('XT received 1.2M DEOD.').ok).toBe(false);                               // real value 1.11M
    expect(check('XT and Toobit together moved 2.64M DEOD.').ok).toBe(false);             // a sum the tools never returned
    expect(check('That is 12.5% of the total.').ok).toBe(false);                          // a percentage the tools never returned
  });
  it('accepts a figure that appears in the question (the user said it first)', () => {
    expect(check('Yes, 750,000 DEOD is above that.', 'Is 750,000 DEOD a large transfer?').ok).toBe(true);
    expect(check('Yes, 750,000 DEOD is above that.').ok).toBe(false);
  });
  it('does not mistake hashes, dates and addresses in an answer for figures', () => {
    expect(check('The swap was at 2026-10-22 04:38 UTC, transaction 0x15ee94773afbf63e9824b231ee9d7ad20a09d16512057225778efedeac46c7fc.').ok).toBe(true);
  });
  it('with no tool data at all, any real figure is unverified', () => {
    expect(verifyAnswer('DEOD moved 5M today.', []).ok).toBe(false);
    expect(verifyAnswer('I could not find any data for that period.', []).ok).toBe(true);
  });
});
