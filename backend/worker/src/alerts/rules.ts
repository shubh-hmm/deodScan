// Deterministic alert rules. Pure functions: rows in, alert candidates out. No database, no network, no AI, no clock except the `now`
// that is passed in, so every rule is exactly testable. Amounts are decimal strings and are compared with Decimal, never floats.
import { Decimal } from 'decimal.js';

export type Severity = 'low' | 'medium' | 'high';

/** A row of exchange_flows. direction is from the EXCHANGE's point of view: IN = a wallet deposited, OUT = the exchange paid a wallet. */
export interface FlowRow {
  id: number; exchange: string; direction: 'IN' | 'OUT'; wallet_address: string; exchange_address: string;
  amount: string; tx_hash: string; evt_index: number; block_number: number; block_time: Date;
}

/** A row of dex_swaps. trader = the transaction signer, pool = the PancakeSwap pool. BUY = the pool paid DEOD out. */
export interface SwapRow {
  id: number; version: string; pool_address: string; trader_address: string; side: 'BUY' | 'SELL';
  deod_amount: string; usd_value: string | null; tx_hash: string; evt_index: number; block_number: number; block_time: Date;
}

export interface WatchedWallet { address: string; watch: 'both' | 'incoming' | 'outgoing'; min_amount: string; enabled: boolean }

export interface AlertCandidate {
  dedupKey: string;
  ruleCode: string;
  severity: Severity;
  source: 'exchange_flow' | 'swap' | 'daily_flow';
  occurredAt: Date;
  exchange: string | null;
  direction: string | null;
  amount: string;
  usdValue: string | null;
  sender: string | null;
  recipient: string | null;
  walletAddress: string | null;
  txHash: string | null;
  evtIndex: number | null;
  blockNumber: number | null;
  details: Record<string, unknown>;
}

export interface ThresholdRule { code: string; enabled: boolean; severity: Severity; min_amount: number }
export interface SpikeRule { code: string; enabled: boolean; severity: Severity; multiplier: number; min_history_days: number; min_amount: number }

const DAY_MS = 86_400_000;

/** Rows older than this are never alerted on (a backfill must not raise a flood of old alerts). */
export function isTooOld(blockTime: Date, now: Date, maxAgeDays: number): boolean {
  return now.getTime() - blockTime.getTime() > maxAgeDays * DAY_MS;
}

/** Who sent and who received, from the row itself. For an exchange transfer the exchange address is one side. */
export function flowEndpoints(f: Pick<FlowRow, 'direction' | 'wallet_address' | 'exchange_address'>) {
  return f.direction === 'IN'
    ? { sender: f.wallet_address, recipient: f.exchange_address }
    : { sender: f.exchange_address, recipient: f.wallet_address };
}

export function swapEndpoints(s: Pick<SwapRow, 'side' | 'pool_address' | 'trader_address'>) {
  return s.side === 'BUY'
    ? { sender: s.pool_address, recipient: s.trader_address }
    : { sender: s.trader_address, recipient: s.pool_address };
}

const flowCandidate = (f: FlowRow, ruleCode: string, severity: Severity, walletAddress: string, details: Record<string, unknown>, key: string): AlertCandidate => ({
  dedupKey: key, ruleCode, severity, source: 'exchange_flow', occurredAt: f.block_time, exchange: f.exchange, direction: f.direction,
  amount: f.amount, usdValue: null, ...flowEndpoints(f), walletAddress, txHash: f.tx_hash, evtIndex: f.evt_index, blockNumber: f.block_number, details,
});

const swapCandidate = (s: SwapRow, ruleCode: string, severity: Severity, walletAddress: string, details: Record<string, unknown>, key: string): AlertCandidate => ({
  dedupKey: key, ruleCode, severity, source: 'swap', occurredAt: s.block_time, exchange: null, direction: s.side,
  amount: s.deod_amount, usdValue: s.usd_value, ...swapEndpoints(s), walletAddress, txHash: s.tx_hash, evtIndex: s.evt_index, blockNumber: s.block_number, details,
});

/** One exchange transfer of at least min_amount DEOD (the amount itself is included: >=). */
export function largeTransferAlerts(flows: FlowRow[], rule: ThresholdRule, now: Date, maxAgeDays: number): AlertCandidate[] {
  if (!rule.enabled) return [];
  const min = new Decimal(rule.min_amount);
  return flows
    .filter((f) => !isTooOld(f.block_time, now, maxAgeDays) && new Decimal(f.amount).gte(min))
    .map((f) => flowCandidate(f, rule.code, rule.severity, f.wallet_address, { threshold: rule.min_amount },
      `${rule.code}:${f.exchange_address}:${f.tx_hash}:${f.evt_index}:${f.direction}`));
}

/** One PancakeSwap swap of at least min_amount DEOD. */
export function largeSwapAlerts(swaps: SwapRow[], rule: ThresholdRule, now: Date, maxAgeDays: number): AlertCandidate[] {
  if (!rule.enabled) return [];
  const min = new Decimal(rule.min_amount);
  return swaps
    .filter((s) => !isTooOld(s.block_time, now, maxAgeDays) && new Decimal(s.deod_amount).gte(min))
    .map((s) => swapCandidate(s, rule.code, rule.severity, s.trader_address, { threshold: rule.min_amount, pool_version: s.version },
      `${rule.code}:${s.tx_hash}:${s.evt_index}`));
}

/**
 * Whether a recorded movement is incoming or outgoing from the WATCHED WALLET's point of view:
 * an exchange IN means the wallet sent DEOD to the exchange (outgoing); an exchange OUT means the wallet received it (incoming);
 * a swap BUY means the trader received DEOD (incoming); a SELL means the trader sent it (outgoing).
 */
const flowSide = (f: FlowRow) => (f.direction === 'IN' ? 'outgoing' : 'incoming') as 'incoming' | 'outgoing';
const swapSide = (s: SwapRow) => (s.side === 'BUY' ? 'incoming' : 'outgoing') as 'incoming' | 'outgoing';

const wants = (w: WatchedWallet, side: 'incoming' | 'outgoing', amount: string) =>
  w.enabled && (w.watch === 'both' || w.watch === side) && new Decimal(amount).gte(new Decimal(w.min_amount));

/** Recorded transfers and swaps that involve a watched wallet. It sees only what is stored; it cannot see unrecorded wallet transfers. */
export function watchedWalletAlerts(
  flows: FlowRow[], swaps: SwapRow[], watched: WatchedWallet[], severity: Severity, ruleCode: string, now: Date, maxAgeDays: number,
): AlertCandidate[] {
  const byAddress = new Map(watched.map((w) => [w.address.toLowerCase(), w]));
  const out: AlertCandidate[] = [];
  for (const f of flows) {
    const w = byAddress.get(f.wallet_address.toLowerCase());
    if (!w || isTooOld(f.block_time, now, maxAgeDays)) continue;
    const side = flowSide(f);
    if (wants(w, side, f.amount)) {
      out.push(flowCandidate(f, ruleCode, severity, w.address, { wallet_side: side, kind: 'exchange_transfer' },
        `${ruleCode}:${w.address}:${f.exchange_address}:${f.tx_hash}:${f.evt_index}:${f.direction}`));
    }
  }
  for (const s of swaps) {
    const w = byAddress.get(s.trader_address.toLowerCase());
    if (!w || isTooOld(s.block_time, now, maxAgeDays)) continue;
    const side = swapSide(s);
    if (wants(w, side, s.deod_amount)) {
      out.push(swapCandidate(s, ruleCode, severity, w.address, { wallet_side: side, kind: 'swap', pool_version: s.version },
        `${ruleCode}:${w.address}:${s.tx_hash}:${s.evt_index}`));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Unusual daily flow
// ---------------------------------------------------------------------------

/** One exchange, one direction, one finished UTC day, with its baseline already computed from stored data. */
export interface DayTotal {
  exchange: string; direction: 'IN' | 'OUT'; day: string;       // day = 'YYYY-MM-DD' (UTC)
  total: string;                                                  // DEOD moved that day
  baselineMean: string;                                           // average daily total over the previous tracked days (zeros included)
  trackedDays: number;                                            // how many previous days the baseline is based on (<= baseline_days)
}

export type SpikeVerdict = { alert: true; ratio: string | null } | { alert: false; reason: 'insufficient_history' | 'below_min_amount' | 'below_multiplier' };

/** The decision itself, separate from the database so it can be tested exactly. */
export function judgeFlowSpike(d: DayTotal, rule: SpikeRule): SpikeVerdict {
  if (d.trackedDays < rule.min_history_days) return { alert: false, reason: 'insufficient_history' };
  const total = new Decimal(d.total);
  if (total.lt(rule.min_amount)) return { alert: false, reason: 'below_min_amount' };
  const mean = new Decimal(d.baselineMean);
  if (mean.isZero()) return { alert: true, ratio: null };                      // activity after a quiet baseline of at least min_history_days
  if (total.lt(mean.times(rule.multiplier))) return { alert: false, reason: 'below_multiplier' };
  return { alert: true, ratio: total.div(mean).toDecimalPlaces(2).toString() };
}

export function flowSpikeAlerts(days: DayTotal[], rule: SpikeRule, baselineDays: number): { alerts: AlertCandidate[]; insufficientHistory: number } {
  const alerts: AlertCandidate[] = [];
  let insufficientHistory = 0;
  if (!rule.enabled) return { alerts, insufficientHistory };
  for (const d of days) {
    const v = judgeFlowSpike(d, rule);
    if (!v.alert) { if (v.reason === 'insufficient_history') insufficientHistory++; continue; }
    alerts.push({
      dedupKey: `${rule.code}:${d.exchange}:${d.direction}:${d.day}`, ruleCode: rule.code, severity: rule.severity, source: 'daily_flow',
      occurredAt: new Date(`${d.day}T23:59:59.999Z`), exchange: d.exchange, direction: d.direction, amount: d.total, usdValue: null,
      sender: null, recipient: null, walletAddress: null, txHash: null, evtIndex: null, blockNumber: null,
      details: { day: d.day, baseline_mean: d.baselineMean, baseline_days: baselineDays, tracked_days: d.trackedDays, multiplier: rule.multiplier, ratio: v.ratio },
    });
  }
  return { alerts, insufficientHistory };
}

/**
 * The range of finished UTC days (inclusive, 'YYYY-MM-DD') the flow rule may look at: not today, not older than maxAgeDays, and only
 * days that the sync has fully covered (the whole day lies before the sync checkpoint). null when there is nothing safe to examine.
 */
export function completeDayRange(now: Date, syncedUntil: Date | null, maxAgeDays: number): { first: string; last: string } | null {
  if (!syncedUntil) return null;
  const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const lastByClock = startOfToday - DAY_MS;                                    // yesterday
  const syncedDayStart = Math.floor(syncedUntil.getTime() / DAY_MS) * DAY_MS;  // the checkpoint is a midnight: days before it are complete
  const last = Math.min(lastByClock, syncedDayStart - DAY_MS);
  const first = startOfToday - Math.ceil(maxAgeDays) * DAY_MS;
  if (last < first) return null;
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { first: iso(first), last: iso(last) };
}
