import { describe, expect, it } from 'vitest';
import {
  classifyFlows, completedDayWindows, normalizeSwap, normalizeTransfer, parseDuneTime, rawToDecimal, utcDayStart, type SwapContext,
} from '../src/index.js';

const DEOD = '0x3510fbbc13090f991ffa523527113a166161683e';
const USDT = '0x55d398326f99059ff775485246999027b3197955';
const V2 = '0xd693c42610bd30e63b0a68a25918445a5f9a1d20';
const V3 = '0x185d73ec966d464a40372cd7e737bb68b0b95f1f';
const MEXC = '0x4982085c9e2f89f2ecb8131eca71afad896e89cb';
const BITMART = '0xa23ef2319ba4c933ebfdba80c332664a6cb13f1a';
const WALLET = '0x1ffbdf86dcd09980ee8e2e89a301c5e15f2d49c7';
const TX = '0x3def554e3be238f665e07efe5ce40c69a4063200b37a545670484937da2b495e';

describe('rawToDecimal', () => {
  it('converts exactly without floating point', () => {
    expect(rawToDecimal('29158937756400000000000000', 18)).toBe('29158937.7564');
    expect(rawToDecimal('24215093903139278568828821', 18)).toBe('24215093.903139278568828821');
    expect(rawToDecimal('1', 18)).toBe('0.000000000000000001');
    expect(rawToDecimal('0', 18)).toBe('0');
    expect(rawToDecimal(-1500000000000000000n, 18)).toBe('-1.5');
  });
  it('handles uint256 max', () => {
    expect(rawToDecimal((2n ** 256n - 1n).toString(), 0)).toBe((2n ** 256n - 1n).toString());
  });
});

describe('parseDuneTime', () => {
  it('parses Dune UTC timestamps', () => {
    expect(parseDuneTime('2026-01-16 08:41:03.000 UTC')).toBe('2026-01-16T08:41:03.000Z');
  });
  it('rejects garbage', () => {
    expect(parseDuneTime('not a date')).toBeNull();
    expect(parseDuneTime(null)).toBeNull();
  });
});

const transfer = (o: Record<string, unknown> = {}) => ({
  block_time: '2026-01-16 08:41:03.000 UTC', block_number: 75573930, tx_hash: TX, evt_index: 475,
  from_address: WALLET, to_address: MEXC, amount_raw: '29158937756400000000000000', tx_from: WALLET, ...o,
});

describe('normalizeTransfer', () => {
  it('accepts a valid row and lowercases addresses', () => {
    const r = normalizeTransfer(transfer({ to_address: MEXC.toUpperCase().replace('0X', '0x') }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.toAddress).toBe(MEXC);
  });
  it.each([
    ['negative amount', { amount_raw: '-5' }],
    ['decimal amount', { amount_raw: '1.5' }],
    ['bad hash', { tx_hash: '0x1234' }],
    ['bad timestamp', { block_time: 'yesterday' }],
    ['bad address', { from_address: '0xnope' }],
    ['missing evt_index', { evt_index: undefined }],
  ])('rejects %s', (_, o) => {
    const r = normalizeTransfer(transfer(o));
    expect(r.ok).toBe(false);
  });
});

describe('classifyFlows', () => {
  const exchangeOf = (a: string) => ({ [MEXC]: 'mexc', [BITMART]: 'bitmart' })[a];
  it('wallet -> exchange is IN', () => {
    expect(classifyFlows({ fromAddress: WALLET, toAddress: MEXC }, exchangeOf)).toEqual([
      { exchange: 'mexc', exchangeAddress: MEXC, walletAddress: WALLET, direction: 'IN' },
    ]);
  });
  it('exchange -> wallet is OUT', () => {
    expect(classifyFlows({ fromAddress: MEXC, toAddress: WALLET }, exchangeOf)).toEqual([
      { exchange: 'mexc', exchangeAddress: MEXC, walletAddress: WALLET, direction: 'OUT' },
    ]);
  });
  it('exchange -> exchange yields one leg per exchange', () => {
    const legs = classifyFlows({ fromAddress: MEXC, toAddress: BITMART }, exchangeOf);
    expect(legs.map((l) => `${l.exchange}:${l.direction}`)).toEqual(['bitmart:IN', 'mexc:OUT']);
  });
  it('self-transfer and unrelated transfers yield nothing', () => {
    expect(classifyFlows({ fromAddress: MEXC, toAddress: MEXC }, exchangeOf)).toEqual([]);
    expect(classifyFlows({ fromAddress: WALLET, toAddress: USDT }, exchangeOf)).toEqual([]);
  });
});

const ctx: SwapContext = {
  deodAddress: DEOD,
  deodDecimals: 18,
  pools: new Map([
    [V2, { version: '2', quoteAddress: USDT, quoteDecimals: 18 }],
    [V3, { version: '3', quoteAddress: USDT, quoteDecimals: 18 }],
  ]),
};

// Rows taken from the verified sample (cross-checked against on-chain Swap logs).
const swap = (o: Record<string, unknown> = {}) => ({
  block_time: '2026-09-30 05:00:00.000 UTC', block_number: 124809314,
  tx_hash: '0x9d36361ced9e6003b6d254d0873a97edfced65155ce328bcc60387569433f166', evt_index: 1240,
  version: '3', pool_address: V3, side: 'BUY',
  deod_amount_raw: '48010632607112639161', quote_amount_raw: '995245158087193500',
  taker: '0x6a000f20005980200259b80c5102003040001068', tx_from: '0x375b62d0727d15f318b2053636820ddde04e7088',
  tx_to: '0x6a000f20005980200259b80c5102003040001068', ...o,
});

describe('normalizeSwap', () => {
  it('normalizes a V3 buy, using tx signer as trader and keeping the router as recipient', () => {
    const r = normalizeSwap(swap(), ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.side).toBe('BUY');
    expect(r.value.traderAddress).toBe('0x375b62d0727d15f318b2053636820ddde04e7088');
    expect(r.value.recipientAddress).toBe('0x6a000f20005980200259b80c5102003040001068');
    // 0.9952451580871935 USDT / 48.010632607112639161 DEOD
    expect(Number(r.value.price)).toBeCloseTo(0.020729684, 8);
  });
  it('normalizes a V2 sell', () => {
    const r = normalizeSwap(swap({
      version: '2', pool_address: V2, side: 'SELL',
      deod_amount_raw: '3150000000000000000000', quote_amount_raw: '64014609741766932563',
    }), ctx);
    expect(r.ok && r.value.side).toBe('SELL');
    expect(r.ok && Number(r.value.price)).toBeCloseTo(64.014609741766932563 / 3150, 12);
  });
  it.each([
    ['UNMATCHED side', { side: 'UNMATCHED' }],
    ['unknown pool', { pool_address: '0x0000000000000000000000000000000000000001' }],
    ['version mismatch', { version: '2' }],
    ['zero DEOD amount', { deod_amount_raw: '0' }],
    ['negative quote', { quote_amount_raw: '-1' }],
  ])('rejects %s', (_, o) => {
    expect(normalizeSwap(swap(o), ctx).ok).toBe(false);
  });
});

describe('completedDayWindows', () => {
  const H = 3600_000;
  const t = (s: string) => new Date(s);
  const days = (w: { start: Date; end: Date }[]) => w.map((x) => `${x.start.toISOString().slice(0, 10)}..${x.end.toISOString().slice(0, 10)}`);

  it('returns nothing until the day has ended plus the settle delay', () => {
    expect(completedDayWindows(t('2026-10-03T00:00:00Z'), t('2026-10-04T01:59:59Z'), 2 * H)).toEqual([]);
    expect(days(completedDayWindows(t('2026-10-03T00:00:00Z'), t('2026-10-04T02:00:00Z'), 2 * H))).toEqual(['2026-10-03..2026-10-04']);
  });
  it('re-fetches the whole day when the checkpoint is mid-day', () => {
    expect(days(completedDayWindows(t('2026-10-03T06:43:47Z'), t('2026-10-04T03:00:00Z'), 2 * H))).toEqual(['2026-10-03..2026-10-04']);
  });
  it('catches up several missed days, one window per day', () => {
    expect(days(completedDayWindows(t('2026-10-01T00:00:00Z'), t('2026-10-04T05:00:00Z'), 2 * H)))
      .toEqual(['2026-10-01..2026-10-02', '2026-10-02..2026-10-03', '2026-10-03..2026-10-04']);
  });
  it('does nothing when already synced through the last completed day', () => {
    expect(completedDayWindows(t('2026-10-04T00:00:00Z'), t('2026-10-04T23:00:00Z'), 2 * H)).toEqual([]);
  });
  it('utcDayStart floors to midnight UTC', () => {
    expect(utcDayStart(t('2026-10-03T23:59:59.999Z')).toISOString()).toBe('2026-10-03T00:00:00.000Z');
  });
});
