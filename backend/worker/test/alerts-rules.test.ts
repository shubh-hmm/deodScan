import { describe, expect, it } from 'vitest';
import {
  completeDayRange, flowEndpoints, flowSpikeAlerts, isTooOld, judgeFlowSpike, largeSwapAlerts, largeTransferAlerts, swapEndpoints,
  watchedWalletAlerts, type DayTotal, type FlowRow, type SpikeRule, type SwapRow, type ThresholdRule, type WatchedWallet,
} from '../src/alerts/rules.js';

const NOW = new Date('2026-10-22T12:00:00Z');
const MEXC = '0x4982085c9e2f89f2ecb8131eca71afad896e89cb';
const W1 = '0x1ffbdf86dcd09980ee8e2e89a301c5e15f2d49c7';
const W2 = '0x2222222222222222222222222222222222222222';
const POOL = '0xd693c42610bd30e63b0a68a25918445a5f9a1d20';
const TX = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

const flow = (o: Partial<FlowRow> = {}): FlowRow => ({
  id: 1, exchange: 'mexc', direction: 'IN', wallet_address: W1, exchange_address: MEXC, amount: '1000', tx_hash: TX(1), evt_index: 5,
  block_number: 100, block_time: new Date('2026-10-21T10:00:00Z'), ...o,
});
const swap = (o: Partial<SwapRow> = {}): SwapRow => ({
  id: 1, version: '3', pool_address: POOL, trader_address: W1, side: 'SELL', deod_amount: '1000', usd_value: '17.5', tx_hash: TX(2), evt_index: 7,
  block_number: 101, block_time: new Date('2026-10-21T11:00:00Z'), ...o,
});
const big: ThresholdRule = { code: 'large_transfer', enabled: true, severity: 'high', min_amount: 500000 };
const bigSwap: ThresholdRule = { code: 'large_swap', enabled: true, severity: 'medium', min_amount: 50000 };
const spike: SpikeRule = { code: 'flow_spike', enabled: true, severity: 'medium', multiplier: 3, min_history_days: 14, min_amount: 250000 };

describe('large transfer rule', () => {
  it('alerts at exactly the threshold and above, never below', () => {
    const rows = [flow({ id: 1, amount: '499999.999999999999999999', tx_hash: TX(1) }), flow({ id: 2, amount: '500000', tx_hash: TX(2) }), flow({ id: 3, amount: '9988641.4', tx_hash: TX(3) })];
    const out = largeTransferAlerts(rows, big, NOW, 7);
    expect(out.map((a) => a.txHash)).toEqual([TX(2), TX(3)]);
    expect(out[0]).toMatchObject({ ruleCode: 'large_transfer', severity: 'high', source: 'exchange_flow', exchange: 'mexc', amount: '500000' });
  });
  it('does not lose precision on 18-decimal amounts', () => {
    const out = largeTransferAlerts([flow({ amount: '500000.000000000000000001' })], big, NOW, 7);
    expect(out).toHaveLength(1);
    expect(out[0]!.amount).toBe('500000.000000000000000001');
  });
  it('gives the sender and recipient from the transfer itself', () => {
    const [deposit] = largeTransferAlerts([flow({ direction: 'IN', amount: '600000' })], big, NOW, 7);
    expect([deposit!.sender, deposit!.recipient]).toEqual([W1, MEXC]);
    const [withdrawal] = largeTransferAlerts([flow({ direction: 'OUT', amount: '600000', tx_hash: TX(9) })], big, NOW, 7);
    expect([withdrawal!.sender, withdrawal!.recipient]).toEqual([MEXC, W1]);
    expect(flowEndpoints({ direction: 'OUT', wallet_address: W2, exchange_address: MEXC })).toEqual({ sender: MEXC, recipient: W2 });
  });
  it('can be switched off', () => {
    expect(largeTransferAlerts([flow({ amount: '9999999' })], { ...big, enabled: false }, NOW, 7)).toEqual([]);
  });
  it('ignores transfers older than the alert window (a backfill raises no old alerts)', () => {
    const old = flow({ amount: '9999999', block_time: new Date('2026-10-01T00:00:00Z') });
    expect(largeTransferAlerts([old], big, NOW, 7)).toEqual([]);
    expect(isTooOld(new Date('2026-10-15T12:00:00Z'), NOW, 7)).toBe(false);
    expect(isTooOld(new Date('2026-10-15T11:59:59Z'), NOW, 7)).toBe(true);
  });
  it('builds the same dedup key for the same transfer every time, and different keys for different transfers', () => {
    const a = largeTransferAlerts([flow({ amount: '600000' })], big, NOW, 7)[0]!;
    const b = largeTransferAlerts([flow({ amount: '600000', id: 99 })], big, NOW, 7)[0]!;   // same event seen again with another row id
    expect(a.dedupKey).toBe(b.dedupKey);
    const c = largeTransferAlerts([flow({ amount: '600000', evt_index: 6 })], big, NOW, 7)[0]!;
    const d = largeTransferAlerts([flow({ amount: '600000', direction: 'OUT' })], big, NOW, 7)[0]!;
    expect(new Set([a.dedupKey, c.dedupKey, d.dedupKey]).size).toBe(3);
  });
});

describe('large swap rule', () => {
  it('alerts on swaps at or above the threshold and keeps the USD value', () => {
    const out = largeSwapAlerts([swap({ deod_amount: '49999.9', tx_hash: TX(1) }), swap({ deod_amount: '50000', tx_hash: TX(2), usd_value: '860.25' })], bigSwap, NOW, 7);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ source: 'swap', direction: 'SELL', usdValue: '860.25', sender: W1, recipient: POOL });
  });
  it('maps BUY to pool -> trader and SELL to trader -> pool', () => {
    expect(swapEndpoints({ side: 'BUY', pool_address: POOL, trader_address: W1 })).toEqual({ sender: POOL, recipient: W1 });
    expect(swapEndpoints({ side: 'SELL', pool_address: POOL, trader_address: W1 })).toEqual({ sender: W1, recipient: POOL });
  });
});

describe('watched wallets', () => {
  const watch = (o: Partial<WatchedWallet> = {}): WatchedWallet => ({ address: W1, watch: 'both', min_amount: '0', enabled: true, ...o });
  const run = (flows: FlowRow[], swaps: SwapRow[], w: WatchedWallet[]) => watchedWalletAlerts(flows, swaps, w, 'medium', 'watched_wallet', NOW, 7);

  it('alerts on recorded exchange transfers and swaps of a watched wallet, and on nobody else', () => {
    const out = run([flow({ wallet_address: W1 }), flow({ wallet_address: W2, tx_hash: TX(3) })], [swap({ trader_address: W1 }), swap({ trader_address: W2, tx_hash: TX(4) })], [watch()]);
    expect(out.map((a) => a.walletAddress)).toEqual([W1, W1]);
  });
  it('matches addresses regardless of letter case', () => {
    expect(run([flow({ wallet_address: W1.toUpperCase().replace('0X', '0x') })], [], [watch()])).toHaveLength(1);
  });
  it('uses the wallet point of view: exchange IN = outgoing, exchange OUT = incoming, BUY = incoming, SELL = outgoing', () => {
    const flows = [flow({ direction: 'IN', tx_hash: TX(1) }), flow({ direction: 'OUT', tx_hash: TX(2) })];
    const swaps = [swap({ side: 'BUY', tx_hash: TX(3) }), swap({ side: 'SELL', tx_hash: TX(4) })];
    expect(run(flows, swaps, [watch({ watch: 'incoming' })]).map((a) => a.txHash)).toEqual([TX(2), TX(3)]);
    expect(run(flows, swaps, [watch({ watch: 'outgoing' })]).map((a) => a.txHash)).toEqual([TX(1), TX(4)]);
    expect(run(flows, swaps, [watch({ watch: 'both' })])).toHaveLength(4);
  });
  it('respects the minimum amount and the enabled flag', () => {
    const flows = [flow({ amount: '99.99', tx_hash: TX(1) }), flow({ amount: '100', tx_hash: TX(2) })];
    expect(run(flows, [], [watch({ min_amount: '100' })]).map((a) => a.txHash)).toEqual([TX(2)]);
    expect(run(flows, [], [watch({ enabled: false })])).toEqual([]);
  });
  it('raises one alert per recorded movement and keeps it distinct from the large-transfer alert for the same transfer', () => {
    const f = flow({ amount: '700000' });
    const w = run([f], [], [watch()])[0]!;
    const l = largeTransferAlerts([f], big, NOW, 7)[0]!;
    expect(w.dedupKey).not.toBe(l.dedupKey);
    expect(run([f], [], [watch()])[0]!.dedupKey).toBe(w.dedupKey);
  });
  it('does not alert on old history of a newly watched wallet', () => {
    expect(run([flow({ block_time: new Date('2026-09-01T00:00:00Z') })], [], [watch()])).toEqual([]);
  });
});

describe('unusual daily flow rule', () => {
  const day = (o: Partial<DayTotal> = {}): DayTotal => ({ exchange: 'mexc', direction: 'IN', day: '2026-10-20', total: '900000', baselineMean: '200000', trackedDays: 30, ...o });

  it('alerts only when at least multiplier x the baseline AND at least the minimum amount', () => {
    expect(judgeFlowSpike(day({ total: '600000' }), spike)).toEqual({ alert: true, ratio: '3' });           // exactly 3x
    expect(judgeFlowSpike(day({ total: '599999' }), spike)).toEqual({ alert: false, reason: 'below_multiplier' });
    expect(judgeFlowSpike(day({ total: '240000', baselineMean: '10000' }), spike)).toEqual({ alert: false, reason: 'below_min_amount' });
  });
  it('does not judge an exchange with too little history (incomplete data)', () => {
    expect(judgeFlowSpike(day({ trackedDays: 13 }), spike)).toEqual({ alert: false, reason: 'insufficient_history' });
    expect(judgeFlowSpike(day({ trackedDays: 14 }), spike).alert).toBe(true);
    const r = flowSpikeAlerts([day({ trackedDays: 3 }), day({ trackedDays: 2, exchange: 'xt' })], spike, 30);
    expect(r.alerts).toEqual([]);
    expect(r.insufficientHistory).toBe(2);
  });
  it('treats a quiet baseline (mean 0) with enough history as unusual, without inventing a ratio', () => {
    expect(judgeFlowSpike(day({ baselineMean: '0', total: '300000' }), spike)).toEqual({ alert: true, ratio: null });
  });
  it('stores the facts behind the alert and a stable dedup key per exchange, direction and day', () => {
    const [a] = flowSpikeAlerts([day()], spike, 30).alerts;
    expect(a).toMatchObject({ dedupKey: 'flow_spike:mexc:IN:2026-10-20', source: 'daily_flow', exchange: 'mexc', direction: 'IN', amount: '900000', txHash: null });
    expect(a!.details).toMatchObject({ day: '2026-10-20', baseline_mean: '200000', baseline_days: 30, tracked_days: 30, multiplier: 3, ratio: '4.5' });
    expect(flowSpikeAlerts([day()], spike, 30).alerts[0]!.dedupKey).toBe(a!.dedupKey);
  });
  it('can be switched off', () => {
    expect(flowSpikeAlerts([day()], { ...spike, enabled: false }, 30).alerts).toEqual([]);
  });
});

describe('which days the daily rule may examine (incomplete days are never judged)', () => {
  it('stops at yesterday and never includes today', () => {
    expect(completeDayRange(NOW, new Date('2026-10-22T00:00:00Z'), 7)).toEqual({ first: '2026-10-15', last: '2026-10-21' });
  });
  it('stops at the last fully synced day when the sync is behind', () => {
    expect(completeDayRange(NOW, new Date('2026-10-19T00:00:00Z'), 7)).toEqual({ first: '2026-10-15', last: '2026-10-18' });
  });
  it('returns nothing when there is no checkpoint or no safe day', () => {
    expect(completeDayRange(NOW, null, 7)).toBeNull();
    expect(completeDayRange(NOW, new Date('2026-10-10T00:00:00Z'), 7)).toBeNull();
  });
});
