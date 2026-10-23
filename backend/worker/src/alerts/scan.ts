// Alert scanner: reads the transfers and swaps that are ALREADY in the database, applies the deterministic rules from rules.ts and stores
// the resulting alerts. It never calls Dune or any other network service (so it can never spend credits) and never needs an AI key.
//
// Safe to run any number of times: alerts have a unique dedup_key (a unique index; duplicates are skipped), and the cursor in alert_state only
// decides which rows are worth examining, not whether an alert may exist twice.
import type { Db } from 'mongodb';
import { Decimal } from 'decimal.js';
import { decStr, getDb, isDuplicateKey, nextIds, toDec128, toDec128OrNull } from '@deod/db';
import { loadAlertsConfig, type AlertsConfig } from '@deod/config';
import {
  completeDayRange, flowSpikeAlerts, largeSwapAlerts, largeTransferAlerts, watchedWalletAlerts,
  type AlertCandidate, type DayTotal, type FlowRow, type SwapRow, type WatchedWallet,
} from './rules.js';

export interface ScanResult {
  scannedFlows: number;
  scannedSwaps: number;
  watchedWallets: number;
  daysExamined: number;
  insufficientHistory: number;       // exchange/direction/day combinations not judged because there was too little history
  spikeSkippedReason: string | null; // why the daily flow rule could not run at all (e.g. no sync checkpoint yet)
  inserted: Record<string, number>;  // new alerts per rule code
  duplicates: number;                // candidates that already existed as alerts
}

/** Copies config/alerts.yaml into alert_rules so every alert can show the rule (and thresholds) that raised it. */
export async function syncAlertRules(db: Db, cfg: AlertsConfig = loadAlertsConfig()) {
  const rows: [string, string, string, boolean, string, object][] = [
    ['large_transfer', 'large_transfer', cfg.rules.large_transfer.name, cfg.rules.large_transfer.enabled, cfg.rules.large_transfer.severity, { min_amount: cfg.rules.large_transfer.min_amount }],
    ['large_swap', 'large_swap', cfg.rules.large_swap.name, cfg.rules.large_swap.enabled, cfg.rules.large_swap.severity, { min_amount: cfg.rules.large_swap.min_amount }],
    ['flow_spike', 'flow_spike', cfg.rules.flow_spike.name, cfg.rules.flow_spike.enabled, cfg.rules.flow_spike.severity,
      { multiplier: cfg.rules.flow_spike.multiplier, baseline_days: cfg.rules.flow_spike.baseline_days, min_history_days: cfg.rules.flow_spike.min_history_days, min_amount: cfg.rules.flow_spike.min_amount }],
    ['watched_wallet', 'watched_wallet', 'Watched wallet activity', true, cfg.watched_wallet.severity, {}],
  ];
  for (const [code, kind, name, enabled, severity, params] of rows) {
    await db.collection('alert_rules').updateOne({ _id: code as never }, { $set: { code, kind, name, enabled, severity, params, updated_at: new Date() } }, { upsert: true });
  }
}

const DAY_MS = 86_400_000;

async function insertAlerts(db: Db, candidates: AlertCandidate[]) {
  const inserted: Record<string, number> = {};
  let duplicates = 0;
  if (!candidates.length) return { inserted, duplicates };
  const firstId = await nextIds(db, 'alerts', candidates.length);
  for (const [i, c] of candidates.entries()) {
    try {
      await db.collection('alerts').insertOne({
        _id: (firstId + i) as never, dedup_key: c.dedupKey, rule_code: c.ruleCode, severity: c.severity, source: c.source, occurred_at: c.occurredAt, exchange: c.exchange,
        direction: c.direction, amount: toDec128(c.amount), usd_value: toDec128OrNull(c.usdValue), sender: c.sender, recipient: c.recipient, wallet_address: c.walletAddress,
        tx_hash: c.txHash, evt_index: c.evtIndex, block_number: c.blockNumber, details: c.details, created_at: new Date(),
      });
      inserted[c.ruleCode] = (inserted[c.ruleCode] ?? 0) + 1;
    } catch (e) {
      if (!isDuplicateKey(e)) throw e;
      duplicates++;
    }
  }
  return { inserted, duplicates };
}

const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/** Per exchange, direction and finished UTC day: the day's total and the average of the preceding days (zeros included). */
async function loadDayTotals(db: Db, first: string, last: string, baselineDays: number, minAmount: number): Promise<DayTotal[]> {
  const from = new Date(Date.parse(`${first}T00:00:00Z`) - baselineDays * DAY_MS);
  const to = new Date(Date.parse(`${last}T00:00:00Z`) + DAY_MS);
  const flows = db.collection('exchange_flows');
  const [tracked, perDayRows] = await Promise.all([
    flows.aggregate([{ $group: { _id: '$exchange', first: { $min: '$block_time' } } }]).toArray(),
    flows.aggregate([
      { $match: { block_time: { $gte: from, $lt: to } } },
      { $group: { _id: { exchange: '$exchange', direction: '$direction', day: { $dateToString: { format: '%Y-%m-%d', date: '$block_time', timezone: 'UTC' } } }, total: { $sum: '$amount' } } },
    ]).toArray(),
  ]);
  const perDay = new Map(perDayRows.map((r) => [`${r._id.exchange}|${r._id.direction}|${r._id.day}`, new Decimal(decStr(r.total))]));
  const out: DayTotal[] = [];
  const days: string[] = [];
  for (let t = Date.parse(`${first}T00:00:00Z`); t <= Date.parse(`${last}T00:00:00Z`); t += DAY_MS) days.push(dayKey(new Date(t)));
  const min = new Decimal(minAmount);
  for (const day of days) {
    for (const t of [...tracked].sort((a, b) => (a._id < b._id ? -1 : 1))) {
      const firstDay = dayKey(t.first as Date);
      if (day < firstDay) continue;
      for (const direction of ['IN', 'OUT'] as const) {
        const cur = perDay.get(`${t._id}|${direction}|${day}`);
        if (!cur || cur.lt(min)) continue;
        const dayMs = Date.parse(`${day}T00:00:00Z`);
        const trackedDays = Math.min(baselineDays, Math.max(Math.round((dayMs - Date.parse(`${firstDay}T00:00:00Z`)) / DAY_MS), 0));
        let sum = new Decimal(0);
        for (let k = 1; k <= baselineDays; k++) sum = sum.plus(perDay.get(`${t._id}|${direction}|${dayKey(new Date(dayMs - k * DAY_MS))}`) ?? 0);
        out.push({ exchange: t._id as string, direction, day, total: decStr(cur), trackedDays, baselineMean: trackedDays ? sum.div(trackedDays).toFixed() : '0' });
      }
    }
  }
  return out;
}

const highestId = async (db: Db, collection: string): Promise<number> =>
  ((await db.collection(collection).find({}, { projection: { _id: 1 } }).sort({ _id: -1 }).limit(1).next())?._id as unknown as number | undefined) ?? 0;

/**
 * One scan. `rescan` forgets the cursors so every recent row is examined again; thanks to the unique dedup_key this can only add
 * alerts that were missing, never duplicate existing ones.
 *
 * There is no transaction: the alerts are idempotent (unique dedup_key) and the cursor is written last, so a scan that dies half way is
 * simply repeated by the next one and creates nothing twice.
 */
export async function scanAlerts(db: Db = getDb(), opts: { now?: Date; rescan?: boolean } = {}): Promise<ScanResult> {
  const now = opts.now ?? new Date();
  const cfg = loadAlertsConfig();
  const maxAge = cfg.scan.max_alert_age_days;
  const cutoff = new Date(now.getTime() - maxAge * DAY_MS);
  const result: ScanResult = {
    scannedFlows: 0, scannedSwaps: 0, watchedWallets: 0, daysExamined: 0, insufficientHistory: 0, spikeSkippedReason: null, inserted: {}, duplicates: 0,
  };
  await syncAlertRules(db, cfg);
  if (opts.rescan) await db.collection('alert_state').deleteMany({});

  const state = new Map((await db.collection('alert_state').find().toArray()).map((r) => [r._id as unknown as string, Number(r.last_id)]));
  const flowFrom = state.get('exchange_flows') ?? 0, swapFrom = state.get('dex_swaps') ?? 0;
  const [flowMax, swapMax] = await Promise.all([highestId(db, 'exchange_flows'), highestId(db, 'dex_swaps')]);

  const flows: FlowRow[] = (await db.collection('exchange_flows').find({ _id: { $gt: flowFrom, $lte: flowMax } as never, block_time: { $gte: cutoff } }).sort({ _id: 1 }).toArray())
    .map((f) => ({
      id: f._id as unknown as number, exchange: f.exchange, direction: f.direction, wallet_address: f.wallet_address, exchange_address: f.exchange_address,
      amount: decStr(f.amount), tx_hash: f.tx_hash, evt_index: f.evt_index, block_number: f.block_number, block_time: f.block_time,
    }));
  const swaps: SwapRow[] = (await db.collection('dex_swaps').find({ _id: { $gt: swapFrom, $lte: swapMax } as never, block_time: { $gte: cutoff } }).sort({ _id: 1 }).toArray())
    .map((s) => ({
      id: s._id as unknown as number, version: s.version, pool_address: s.pool_address, trader_address: s.trader_address, side: s.side, deod_amount: decStr(s.deod_amount),
      usd_value: s.usd_value == null ? null : decStr(s.usd_value), tx_hash: s.tx_hash, evt_index: s.evt_index, block_number: s.block_number, block_time: s.block_time,
    }));
  const watched: WatchedWallet[] = (await db.collection('watched_wallets').find({ enabled: true }).toArray())
    .map((w) => ({ address: w._id as unknown as string, watch: w.watch, min_amount: decStr(w.min_amount), enabled: w.enabled }));
  result.scannedFlows = flows.length; result.scannedSwaps = swaps.length; result.watchedWallets = watched.length;

  const candidates: AlertCandidate[] = [
    ...largeTransferAlerts(flows, { code: 'large_transfer', ...cfg.rules.large_transfer }, now, maxAge),
    ...largeSwapAlerts(swaps, { code: 'large_swap', ...cfg.rules.large_swap }, now, maxAge),
    ...watchedWalletAlerts(flows, swaps, watched, cfg.watched_wallet.severity, 'watched_wallet', now, maxAge),
  ];

  // Unusual daily flow: only finished UTC days that the sync has fully covered.
  const spike = cfg.rules.flow_spike;
  if (spike.enabled) {
    const cp = (await db.collection('dune_sync_state').findOne({ _id: 'exchange_transfers' as never }))?.synced_until as Date | null | undefined;
    const range = completeDayRange(now, cp ?? null, maxAge);
    if (!range) result.spikeSkippedReason = cp ? 'no finished, fully synced day in the alert window' : 'no sync checkpoint yet';
    else {
      const days = await loadDayTotals(db, range.first, range.last, spike.baseline_days, spike.min_amount);
      result.daysExamined = Math.round((Date.parse(range.last) - Date.parse(range.first)) / DAY_MS) + 1;
      const s = flowSpikeAlerts(days, { code: 'flow_spike', ...spike }, spike.baseline_days);
      result.insufficientHistory = s.insufficientHistory;
      candidates.push(...s.alerts);
    }
  }

  const { inserted, duplicates } = await insertAlerts(db, candidates);
  result.inserted = inserted; result.duplicates = duplicates;
  for (const [name, id] of [['exchange_flows', flowMax], ['dex_swaps', swapMax]] as const) {
    await db.collection('alert_state').updateOne({ _id: name as never }, { $set: { name, updated_at: new Date() }, $max: { last_id: id } }, { upsert: true });
  }
  return result;
}
