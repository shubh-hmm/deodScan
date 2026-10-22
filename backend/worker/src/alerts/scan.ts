// Alert scanner: reads the transfers and swaps that are ALREADY in the database, applies the deterministic rules from rules.ts and stores
// the resulting alerts. It never calls Dune or any other network service (so it can never spend credits) and never needs an AI key.
//
// Safe to run any number of times: alerts have a unique dedup_key (INSERT ... ON CONFLICT DO NOTHING), and the cursor in alert_state only
// decides which rows are worth examining, not whether an alert may exist twice.
import type pg from 'pg';
import { getPool } from '@deod/db';
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
export async function syncAlertRules(db: pg.Pool | pg.PoolClient, cfg: AlertsConfig = loadAlertsConfig()) {
  const rows: [string, string, string, boolean, string, object][] = [
    ['large_transfer', 'large_transfer', cfg.rules.large_transfer.name, cfg.rules.large_transfer.enabled, cfg.rules.large_transfer.severity, { min_amount: cfg.rules.large_transfer.min_amount }],
    ['large_swap', 'large_swap', cfg.rules.large_swap.name, cfg.rules.large_swap.enabled, cfg.rules.large_swap.severity, { min_amount: cfg.rules.large_swap.min_amount }],
    ['flow_spike', 'flow_spike', cfg.rules.flow_spike.name, cfg.rules.flow_spike.enabled, cfg.rules.flow_spike.severity,
      { multiplier: cfg.rules.flow_spike.multiplier, baseline_days: cfg.rules.flow_spike.baseline_days, min_history_days: cfg.rules.flow_spike.min_history_days, min_amount: cfg.rules.flow_spike.min_amount }],
    ['watched_wallet', 'watched_wallet', 'Watched wallet activity', true, cfg.watched_wallet.severity, {}],
  ];
  for (const [code, kind, name, enabled, severity, params] of rows) {
    await db.query(
      `INSERT INTO alert_rules (code, kind, name, enabled, severity, params) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (code) DO UPDATE SET name = $3, enabled = $4, severity = $5, params = $6, updated_at = now()`,
      [code, kind, name, enabled, severity, JSON.stringify(params)],
    );
  }
}

const DAY_MS = 86_400_000;

async function insertAlerts(db: pg.Pool | pg.PoolClient, candidates: AlertCandidate[]) {
  const inserted: Record<string, number> = {};
  let duplicates = 0;
  for (const c of candidates) {
    const { rowCount } = await db.query(
      `INSERT INTO alerts (dedup_key, rule_code, severity, source, occurred_at, exchange, direction, amount, usd_value, sender, recipient,
                           wallet_address, tx_hash, evt_index, block_number, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       ON CONFLICT (dedup_key) DO NOTHING`,
      [c.dedupKey, c.ruleCode, c.severity, c.source, c.occurredAt, c.exchange, c.direction, c.amount, c.usdValue, c.sender, c.recipient,
        c.walletAddress, c.txHash, c.evtIndex, c.blockNumber, JSON.stringify(c.details)],
    );
    if (rowCount) inserted[c.ruleCode] = (inserted[c.ruleCode] ?? 0) + 1;
    else duplicates++;
  }
  return { inserted, duplicates };
}

/** Per exchange, direction and finished UTC day: the day's total and the average of the preceding days (zeros included). */
async function loadDayTotals(db: pg.Pool | pg.PoolClient, first: string, last: string, baselineDays: number, minAmount: number): Promise<DayTotal[]> {
  const from = new Date(Date.parse(`${first}T00:00:00Z`) - baselineDays * DAY_MS).toISOString();
  const to = new Date(Date.parse(`${last}T00:00:00Z`) + DAY_MS).toISOString();
  const { rows } = await db.query(
    `WITH tracked AS (
       SELECT exchange, min((block_time AT TIME ZONE 'UTC')::date) AS first_day FROM exchange_flows GROUP BY exchange
     ), per_day AS (
       SELECT exchange, direction, (block_time AT TIME ZONE 'UTC')::date AS d, sum(amount) AS total
       FROM exchange_flows WHERE block_time >= $3::timestamptz AND block_time < $4::timestamptz GROUP BY 1, 2, 3
     ), days AS (
       SELECT g::date AS d FROM generate_series($1::date, $2::date, interval '1 day') g
     )
     SELECT t.exchange, dir.direction, to_char(days.d, 'YYYY-MM-DD') AS day, cur.total::text AS total,
            LEAST($5::int, GREATEST(days.d - t.first_day, 0)) AS tracked_days,
            (coalesce((SELECT sum(p.total) FROM per_day p WHERE p.exchange = t.exchange AND p.direction = dir.direction
                        AND p.d >= days.d - $5::int AND p.d < days.d), 0)
              / NULLIF(LEAST($5::int, GREATEST(days.d - t.first_day, 0)), 0))::text AS baseline_mean
     FROM tracked t
     CROSS JOIN (VALUES ('IN'), ('OUT')) dir(direction)
     CROSS JOIN days
     JOIN per_day cur ON cur.exchange = t.exchange AND cur.direction = dir.direction AND cur.d = days.d
     WHERE days.d >= t.first_day AND cur.total >= $6::numeric
     ORDER BY days.d, t.exchange, dir.direction`,
    [first, last, from, to, baselineDays, minAmount],
  );
  return rows.map((r) => ({
    exchange: r.exchange, direction: r.direction, day: r.day, total: r.total, trackedDays: Number(r.tracked_days), baselineMean: r.baseline_mean ?? '0',
  }));
}

/**
 * One scan. `rescan` forgets the cursors so every recent row is examined again; thanks to the unique dedup_key this can only add
 * alerts that were missing, never duplicate existing ones.
 */
export async function scanAlerts(db: pg.Pool = getPool(), opts: { now?: Date; rescan?: boolean } = {}): Promise<ScanResult> {
  const now = opts.now ?? new Date();
  const cfg = loadAlertsConfig();
  const maxAge = cfg.scan.max_alert_age_days;
  const cutoff = new Date(now.getTime() - maxAge * DAY_MS);
  const client = await db.connect();
  const result: ScanResult = {
    scannedFlows: 0, scannedSwaps: 0, watchedWallets: 0, daysExamined: 0, insufficientHistory: 0, spikeSkippedReason: null, inserted: {}, duplicates: 0,
  };
  try {
    await client.query('BEGIN');
    await syncAlertRules(client, cfg);
    if (opts.rescan) await client.query(`DELETE FROM alert_state`);

    const state = new Map((await client.query<{ name: string; last_id: string }>(`SELECT name, last_id::text FROM alert_state`)).rows.map((r) => [r.name, Number(r.last_id)]));
    const flowFrom = state.get('exchange_flows') ?? 0, swapFrom = state.get('dex_swaps') ?? 0;
    const [{ m: flowMax }] = (await client.query(`SELECT coalesce(max(id), 0)::float8 AS m FROM exchange_flows`)).rows;
    const [{ m: swapMax }] = (await client.query(`SELECT coalesce(max(id), 0)::float8 AS m FROM dex_swaps`)).rows;

    const flows = (await client.query(
      `SELECT id::float8 AS id, exchange, direction, wallet_address, exchange_address, amount::text AS amount, tx_hash, evt_index,
              block_number::float8 AS block_number, block_time
       FROM exchange_flows WHERE id > $1 AND id <= $2 AND block_time >= $3 ORDER BY id`, [flowFrom, flowMax, cutoff])).rows as FlowRow[];
    const swaps = (await client.query(
      `SELECT id::float8 AS id, version, pool_address, trader_address, side, deod_amount::text AS deod_amount, usd_value::text AS usd_value,
              tx_hash, evt_index, block_number::float8 AS block_number, block_time
       FROM dex_swaps WHERE id > $1 AND id <= $2 AND block_time >= $3 ORDER BY id`, [swapFrom, swapMax, cutoff])).rows as SwapRow[];
    const watched = (await client.query(
      `SELECT address, watch, min_amount::text AS min_amount, enabled FROM watched_wallets WHERE enabled`)).rows as WatchedWallet[];
    result.scannedFlows = flows.length; result.scannedSwaps = swaps.length; result.watchedWallets = watched.length;

    const candidates: AlertCandidate[] = [
      ...largeTransferAlerts(flows, { code: 'large_transfer', ...cfg.rules.large_transfer }, now, maxAge),
      ...largeSwapAlerts(swaps, { code: 'large_swap', ...cfg.rules.large_swap }, now, maxAge),
      ...watchedWalletAlerts(flows, swaps, watched, cfg.watched_wallet.severity, 'watched_wallet', now, maxAge),
    ];

    // Unusual daily flow: only finished UTC days that the sync has fully covered.
    const spike = cfg.rules.flow_spike;
    if (spike.enabled) {
      const { rows: [cp] } = await client.query<{ synced_until: Date | null }>(`SELECT synced_until FROM dune_sync_state WHERE query_name = 'exchange_transfers'`);
      const range = completeDayRange(now, cp?.synced_until ?? null, maxAge);
      if (!range) result.spikeSkippedReason = cp?.synced_until ? 'no finished, fully synced day in the alert window' : 'no sync checkpoint yet';
      else {
        const days = await loadDayTotals(client, range.first, range.last, spike.baseline_days, spike.min_amount);
        result.daysExamined = Math.round((Date.parse(range.last) - Date.parse(range.first)) / DAY_MS) + 1;
        const s = flowSpikeAlerts(days, { code: 'flow_spike', ...spike }, spike.baseline_days);
        result.insufficientHistory = s.insufficientHistory;
        candidates.push(...s.alerts);
      }
    }

    const { inserted, duplicates } = await insertAlerts(client, candidates);
    result.inserted = inserted; result.duplicates = duplicates;
    for (const [name, id] of [['exchange_flows', flowMax], ['dex_swaps', swapMax]] as const) {
      await client.query(
        `INSERT INTO alert_state (name, last_id) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET last_id = GREATEST(alert_state.last_id, $2), updated_at = now()`, [name, id]);
    }
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
