import type pg from 'pg';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Time ranges
// ---------------------------------------------------------------------------

export const RANGE_MS = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 24 * 3600e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3 } as const;
export type RangeKey = keyof typeof RANGE_MS | 'all' | 'custom';

const isoDate = z.string().refine((s) => !Number.isNaN(new Date(s).getTime()), 'invalid date');

export const RangeQuery = z.object({
  range: z.enum(['1h', '6h', '24h', '7d', '30d', 'all', 'custom']).default('24h'),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export interface Window { from: Date | null; to: Date; range: RangeKey; bucket: 'hour' | 'day' }

export function resolveWindow(q: z.infer<typeof RangeQuery>, now = new Date()): Window {
  let from: Date | null;
  let to = now;
  if (q.range === 'custom') {
    if (!q.from) throw new Error('custom range requires from');
    from = new Date(q.from);
    to = q.to ? new Date(q.to) : now;
    if (from >= to) throw new Error('from must be before to');
  } else if (q.range === 'all') {
    from = null;
  } else {
    from = new Date(now.getTime() - RANGE_MS[q.range]);
  }
  const span = to.getTime() - (from?.getTime() ?? 0);
  return { from, to, range: q.range, bucket: from && span <= 3 * 86400e3 ? 'hour' : 'day' };
}

const EPOCH = new Date('2000-01-01T00:00:00Z');
const lo = (w: Window) => w.from ?? EPOCH;

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export async function overview(db: pg.Pool, w: Window) {
  const [byExchange, totals, swaps] = await Promise.all([
    db.query(
      `SELECT e.slug AS exchange, e.name,
              coalesce(sum(f.amount) FILTER (WHERE f.direction = 'IN'), 0)::text  AS inflow,
              coalesce(sum(f.amount) FILTER (WHERE f.direction = 'OUT'), 0)::text AS outflow,
              (coalesce(sum(f.amount) FILTER (WHERE f.direction = 'IN'), 0)
               - coalesce(sum(f.amount) FILTER (WHERE f.direction = 'OUT'), 0))::text AS net,
              count(f.id) FILTER (WHERE f.direction = 'IN')  AS deposits,
              count(f.id) FILTER (WHERE f.direction = 'OUT') AS withdrawals,
              count(DISTINCT f.wallet_address) AS unique_wallets
       FROM exchanges e
       LEFT JOIN exchange_flows f ON f.exchange = e.slug AND f.block_time >= $1 AND f.block_time < $2
       GROUP BY e.slug, e.name ORDER BY e.name`,
      [lo(w), w.to],
    ),
    db.query(
      `WITH act AS (
         SELECT wallet_address AS addr, tx_hash, evt_index FROM exchange_flows WHERE block_time >= $1 AND block_time < $2
         UNION ALL
         SELECT trader_address, tx_hash, evt_index FROM dex_swaps WHERE block_time >= $1 AND block_time < $2
       )
       SELECT count(DISTINCT addr) AS unique_wallets,
              (SELECT count(*) FROM token_transfers WHERE block_time >= $1 AND block_time < $2) AS exchange_transfers,
              (SELECT coalesce(sum(amount) FILTER (WHERE direction = 'IN'), 0)::text FROM exchange_flows WHERE block_time >= $1 AND block_time < $2) AS inflow,
              (SELECT coalesce(sum(amount) FILTER (WHERE direction = 'OUT'), 0)::text FROM exchange_flows WHERE block_time >= $1 AND block_time < $2) AS outflow,
              (SELECT (coalesce(sum(amount) FILTER (WHERE direction = 'IN'), 0) - coalesce(sum(amount) FILTER (WHERE direction = 'OUT'), 0))::text
                 FROM exchange_flows WHERE block_time >= $1 AND block_time < $2) AS net
       FROM act`,
      [lo(w), w.to],
    ),
    pancakeStats(db, w, 'all'),
  ]);
  const t = totals.rows[0];
  return {
    window: w,
    exchanges: byExchange.rows,
    totals: {
      inflow: t.inflow as string,
      outflow: t.outflow as string,
      net: t.net as string,
      uniqueWallets: Number(t.unique_wallets),
      exchangeTransfers: Number(t.exchange_transfers),
    },
    pancakeswap: swaps,
  };
}

// ---------------------------------------------------------------------------
// Exchange flows
// ---------------------------------------------------------------------------

export async function exchangeStats(db: pg.Pool, exchange: string, w: Window) {
  const { rows } = await db.query(
    `SELECT coalesce(sum(amount) FILTER (WHERE direction = 'IN'), 0)::text  AS inflow,
            coalesce(sum(amount) FILTER (WHERE direction = 'OUT'), 0)::text AS outflow,
            (coalesce(sum(amount) FILTER (WHERE direction = 'IN'), 0)
             - coalesce(sum(amount) FILTER (WHERE direction = 'OUT'), 0))::text AS net,
            count(*) FILTER (WHERE direction = 'IN')  AS deposits,
            count(*) FILTER (WHERE direction = 'OUT') AS withdrawals,
            count(DISTINCT wallet_address) FILTER (WHERE direction = 'IN')  AS unique_depositors,
            count(DISTINCT wallet_address) FILTER (WHERE direction = 'OUT') AS unique_withdrawers,
            count(DISTINCT wallet_address) AS unique_wallets,
            max(amount) FILTER (WHERE direction = 'IN')::text  AS largest_deposit,
            max(amount) FILTER (WHERE direction = 'OUT')::text AS largest_withdrawal
     FROM exchange_flows WHERE exchange = $1 AND block_time >= $2 AND block_time < $3`,
    [exchange, lo(w), w.to],
  );
  return rows[0];
}

/** Bucketed IN/OUT per exchange. Empty buckets are omitted; the chart fills gaps. */
export async function flowSeries(db: pg.Pool, w: Window, exchange?: string) {
  const { rows } = await db.query(
    `SELECT date_trunc($4, block_time) AS bucket, exchange,
            coalesce(sum(amount) FILTER (WHERE direction = 'IN'), 0)::text  AS inflow,
            coalesce(sum(amount) FILTER (WHERE direction = 'OUT'), 0)::text AS outflow
     FROM exchange_flows
     WHERE block_time >= $1 AND block_time < $2 AND ($3::text IS NULL OR exchange = $3)
     GROUP BY 1, 2 ORDER BY 1, 2`,
    [lo(w), w.to, exchange ?? null, w.bucket],
  );
  return rows;
}

/** Exchange transfers per UTC hour of day (0-23) in the window, split IN / OUT. Hours with no activity are returned as zeros. */
export async function hourlyActivity(db: pg.Pool, w: Window) {
  const { rows } = await db.query(
    `SELECT h.hour,
            coalesce(f.inflows, 0)::int  AS inflows,
            coalesce(f.outflows, 0)::int AS outflows
     FROM generate_series(0, 23) AS h(hour)
     LEFT JOIN (
       SELECT extract(hour FROM block_time AT TIME ZONE 'UTC')::int AS hour,
              count(*) FILTER (WHERE direction = 'IN')  AS inflows,
              count(*) FILTER (WHERE direction = 'OUT') AS outflows
       FROM exchange_flows WHERE block_time >= $1 AND block_time < $2 GROUP BY 1
     ) f USING (hour)
     ORDER BY h.hour`,
    [lo(w), w.to],
  );
  return rows as { hour: number; inflows: number; outflows: number }[];
}

/**
 * Every monitored transaction in the window, newest first: exchange transfers (type "exchange") and PancakeSwap swaps
 * (type "swap") in one list with common columns. wallet_address is the counterparty wallet for an exchange transfer and the
 * transaction signer for a swap; counterparty is the exchange address or the pool. Quote/price/USD columns are empty for transfers.
 */
export async function listActivity(db: pg.Pool, w: Window, limit: number) {
  const { rows } = await db.query(
    `SELECT * FROM (
       SELECT block_time, 'exchange' AS type, exchange AS venue, direction AS action, wallet_address,
              exchange_address AS counterparty, amount::text AS deod_amount, NULL::text AS quote_amount,
              NULL::text AS price, NULL::text AS usd_value, tx_hash, evt_index, block_number
       FROM exchange_flows WHERE block_time >= $1 AND block_time < $2
       UNION ALL
       SELECT block_time, 'swap', 'pancakeswap_v' || version, side, trader_address,
              pool_address, deod_amount::text, quote_amount::text, price::text, usd_value::text, tx_hash, evt_index, block_number
       FROM dex_swaps WHERE block_time >= $1 AND block_time < $2
     ) t ORDER BY block_time DESC, evt_index DESC LIMIT $3`,
    [lo(w), w.to, limit],
  );
  return rows;
}

export const FlowFilter = z.object({
  exchange: z.string().regex(/^[a-z0-9_]+$/).optional(),
  direction: z.enum(['IN', 'OUT']).optional(),
  wallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((s) => s.toLowerCase()).optional(),
  min: z.coerce.number().nonnegative().optional(),
  max: z.coerce.number().nonnegative().optional(),
  sort: z.enum(['time', 'amount']).default('time'),
  limit: z.coerce.number().int().min(1).max(10000).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function listFlows(db: pg.Pool, w: Window, f: z.infer<typeof FlowFilter>) {
  const order = f.sort === 'amount' ? 'amount DESC, block_time DESC' : 'block_time DESC, evt_index DESC';
  const where = `block_time >= $1 AND block_time < $2
    AND ($3::text IS NULL OR exchange = $3) AND ($4::text IS NULL OR direction = $4)
    AND ($5::text IS NULL OR wallet_address = $5)
    AND ($6::numeric IS NULL OR amount >= $6) AND ($7::numeric IS NULL OR amount <= $7)`;
  const params = [lo(w), w.to, f.exchange ?? null, f.direction ?? null, f.wallet ?? null, f.min ?? null, f.max ?? null];
  const [rows, count] = await Promise.all([
    db.query(
      `SELECT block_time, exchange, direction, wallet_address, exchange_address, amount::text, amount_raw::text,
              tx_hash, evt_index, block_number
       FROM exchange_flows WHERE ${where} ORDER BY ${order} LIMIT $8 OFFSET $9`,
      [...params, f.limit, f.offset],
    ),
    db.query(`SELECT count(*)::int AS n FROM exchange_flows WHERE ${where}`, params),
  ]);
  return { total: count.rows[0].n as number, rows: rows.rows };
}

export async function topExchangeWallets(db: pg.Pool, exchange: string, direction: 'IN' | 'OUT', w: Window, limit = 25) {
  const { rows } = await db.query(
    `SELECT wallet_address, sum(amount)::text AS total, count(*) AS transfers,
            max(amount)::text AS largest, min(block_time) AS first_seen, max(block_time) AS last_seen
     FROM exchange_flows
     WHERE exchange = $1 AND direction = $2 AND block_time >= $3 AND block_time < $4
     GROUP BY wallet_address ORDER BY sum(amount) DESC LIMIT $5`,
    [exchange, direction, lo(w), w.to, limit],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// PancakeSwap
// ---------------------------------------------------------------------------

export type VersionSel = '2' | '3' | 'all';

export async function pancakeStats(db: pg.Pool, w: Window, version: VersionSel) {
  const { rows } = await db.query(
    `SELECT coalesce(sum(deod_amount), 0)::text AS deod_volume,
            coalesce(sum(deod_amount) FILTER (WHERE side = 'BUY'), 0)::text  AS buy_deod,
            coalesce(sum(deod_amount) FILTER (WHERE side = 'SELL'), 0)::text AS sell_deod,
            coalesce(sum(usd_value), 0)::text AS usd_volume,
            coalesce(sum(usd_value) FILTER (WHERE side = 'BUY'), 0)::text  AS buy_usd,
            coalesce(sum(usd_value) FILTER (WHERE side = 'SELL'), 0)::text AS sell_usd,
            count(*) AS swaps,
            count(*) FILTER (WHERE side = 'BUY')  AS buys,
            count(*) FILTER (WHERE side = 'SELL') AS sells,
            count(DISTINCT trader_address) AS unique_wallets,
            max(deod_amount)::text AS largest_swap_deod,
            (array_agg(price ORDER BY block_number DESC, evt_index DESC))[1]::text AS last_price,
            max(block_time) AS last_swap_time
     FROM dex_swaps
     WHERE block_time >= $1 AND block_time < $2 AND ($3::text = 'all' OR version = $3)`,
    [lo(w), w.to, version],
  );
  return rows[0];
}

export async function swapSeries(db: pg.Pool, w: Window, version: VersionSel) {
  const { rows } = await db.query(
    `SELECT date_trunc($4, block_time) AS bucket, version,
            coalesce(sum(deod_amount) FILTER (WHERE side = 'BUY'), 0)::text  AS buy_deod,
            coalesce(sum(deod_amount) FILTER (WHERE side = 'SELL'), 0)::text AS sell_deod,
            coalesce(sum(usd_value), 0)::text AS usd_volume,
            count(*) AS swaps
     FROM dex_swaps
     WHERE block_time >= $1 AND block_time < $2 AND ($3::text = 'all' OR version = $3)
     GROUP BY 1, 2 ORDER BY 1, 2`,
    [lo(w), w.to, version, w.bucket],
  );
  return rows;
}

export const SwapFilter = z.object({
  version: z.enum(['2', '3', 'all']).default('all'),
  side: z.enum(['BUY', 'SELL']).optional(),
  wallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((s) => s.toLowerCase()).optional(),
  min: z.coerce.number().nonnegative().optional(),
  max: z.coerce.number().nonnegative().optional(),
  sort: z.enum(['time', 'amount']).default('time'),
  limit: z.coerce.number().int().min(1).max(10000).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function listSwaps(db: pg.Pool, w: Window, f: z.infer<typeof SwapFilter>) {
  const order = f.sort === 'amount' ? 'deod_amount DESC, block_time DESC' : 'block_time DESC, evt_index DESC';
  const where = `block_time >= $1 AND block_time < $2 AND ($3::text = 'all' OR version = $3)
    AND ($4::text IS NULL OR side = $4) AND ($5::text IS NULL OR trader_address = $5)
    AND ($6::numeric IS NULL OR deod_amount >= $6) AND ($7::numeric IS NULL OR deod_amount <= $7)`;
  const params = [lo(w), w.to, f.version, f.side ?? null, f.wallet ?? null, f.min ?? null, f.max ?? null];
  const [rows, count] = await Promise.all([
    db.query(
      `SELECT block_time, version, pool_address, side, trader_address, recipient_address,
              deod_amount::text, quote_amount::text, price::text, usd_value::text, usd_basis, tx_hash, evt_index, block_number
       FROM dex_swaps WHERE ${where} ORDER BY ${order} LIMIT $8 OFFSET $9`,
      [...params, f.limit, f.offset],
    ),
    db.query(`SELECT count(*)::int AS n FROM dex_swaps WHERE ${where}`, params),
  ]);
  return { total: count.rows[0].n as number, rows: rows.rows };
}

// ---------------------------------------------------------------------------
// Wallets
// ---------------------------------------------------------------------------

/** Activity sources a wallet ranking can be restricted to. */
export const SOURCES = /^(all|pancakeswap|pancakeswap_v2|pancakeswap_v3|[a-z0-9_]+)$/;

export const TopWalletQuery = z.object({
  source: z.string().regex(SOURCES).default('all'),
  sort: z.enum(['volume', 'transactions', 'largest', 'sent_to_exchanges', 'received_from_exchanges', 'buy', 'sell']).default('volume'),
  minVolume: z.coerce.number().nonnegative().optional(),
  minTx: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(5000).default(50),
});

const SORT_SQL: Record<z.infer<typeof TopWalletQuery>['sort'], string> = {
  volume: 'volume', transactions: 'transactions', largest: 'largest',
  sent_to_exchanges: 'sent_to_exchanges', received_from_exchanges: 'received_from_exchanges',
  buy: 'swap_buy', sell: 'swap_sell',
};

export async function topWallets(db: pg.Pool, w: Window, q: z.infer<typeof TopWalletQuery>) {
  const { rows } = await db.query(
    `WITH act AS (
       SELECT wallet_address AS addr, block_time, tx_hash, amount, exchange AS src, direction AS dir, 'flow' AS kind
       FROM exchange_flows WHERE block_time >= $1 AND block_time < $2
       UNION ALL
       SELECT trader_address, block_time, tx_hash, deod_amount, 'pancakeswap_v' || version, side, 'swap'
       FROM dex_swaps WHERE block_time >= $1 AND block_time < $2
     ),
     filtered AS (
       SELECT * FROM act
       WHERE $3 = 'all' OR src = $3 OR ($3 = 'pancakeswap' AND kind = 'swap')
     )
     SELECT * FROM (
     SELECT addr AS wallet_address,
            sum(amount) AS volume,
            count(DISTINCT tx_hash) AS transactions,
            max(amount) AS largest,
            coalesce(sum(amount) FILTER (WHERE kind = 'flow' AND dir = 'IN'), 0)  AS sent_to_exchanges,
            coalesce(sum(amount) FILTER (WHERE kind = 'flow' AND dir = 'OUT'), 0) AS received_from_exchanges,
            coalesce(sum(amount) FILTER (WHERE kind = 'swap' AND dir = 'BUY'), 0)  AS swap_buy,
            coalesce(sum(amount) FILTER (WHERE kind = 'swap' AND dir = 'SELL'), 0) AS swap_sell,
            min(block_time) AS first_seen, max(block_time) AS last_seen
     FROM filtered
     GROUP BY addr
     HAVING ($4::numeric IS NULL OR sum(amount) >= $4) AND ($5::int IS NULL OR count(DISTINCT tx_hash) >= $5)
     ) ranked
     ORDER BY ${SORT_SQL[q.sort]} DESC, wallet_address
     LIMIT $6`,
    [lo(w), w.to, q.source, q.minVolume ?? null, q.minTx ?? null, q.limit],
  );
  return rows;
}

export async function walletProfile(db: pg.Pool, address: string) {
  const [summary, exchanges, swaps, asRecipient] = await Promise.all([
    db.query(
      `SELECT address, first_seen, last_seen, transaction_count, total_deod_volume::text, sent_to_exchanges::text,
              received_from_exchanges::text, exchange_transfer_count, swap_buy_deod::text, swap_sell_deod::text,
              swap_count, swap_usd_volume::text, largest_transfer::text, largest_swap::text
       FROM wallet_summary WHERE address = $1`,
      [address],
    ),
    db.query(
      `SELECT exchange, direction, sum(amount)::text AS total, count(*) AS transfers, max(amount)::text AS largest,
              min(block_time) AS first_seen, max(block_time) AS last_seen
       FROM exchange_flows WHERE wallet_address = $1 GROUP BY 1, 2 ORDER BY 1, 2`,
      [address],
    ),
    db.query(
      `SELECT version, side, sum(deod_amount)::text AS deod, sum(usd_value)::text AS usd, count(*) AS swaps,
              max(deod_amount)::text AS largest
       FROM dex_swaps WHERE trader_address = $1 GROUP BY 1, 2 ORDER BY 1, 2`,
      [address],
    ),
    db.query(`SELECT count(*)::int AS n FROM dex_swaps WHERE recipient_address = $1 AND trader_address <> $1`, [address]),
  ]);
  return {
    address,
    summary: summary.rows[0] ?? null,
    exchanges: exchanges.rows,
    swaps: swaps.rows,
    swapsAsRecipientOnly: asRecipient.rows[0].n as number,
  };
}

export async function walletTimeline(db: pg.Pool, address: string, limit = 200, offset = 0) {
  const { rows } = await db.query(
    `SELECT * FROM (
       SELECT block_time, 'exchange' AS kind, exchange AS venue, direction AS action, amount::text AS deod_amount,
              NULL::text AS usd_value, exchange_address AS counterparty, tx_hash, evt_index, block_number
       FROM exchange_flows WHERE wallet_address = $1
       UNION ALL
       SELECT block_time, 'swap', 'pancakeswap_v' || version, side, deod_amount::text, usd_value::text,
              pool_address, tx_hash, evt_index, block_number
       FROM dex_swaps WHERE trader_address = $1
     ) t ORDER BY block_time DESC, evt_index DESC LIMIT $2 OFFSET $3`,
    [address, limit, offset],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Search, labels, sync status
// ---------------------------------------------------------------------------

export async function search(db: pg.Pool, q: string) {
  const s = q.trim().toLowerCase();
  if (/^0x[0-9a-f]{64}$/.test(s)) {
    const [f, sw] = await Promise.all([
      db.query(`SELECT 'flow' AS kind, block_time, exchange AS venue, direction AS action, wallet_address, amount::text, tx_hash FROM exchange_flows WHERE tx_hash = $1`, [s]),
      db.query(`SELECT 'swap' AS kind, block_time, 'pancakeswap_v' || version AS venue, side AS action, trader_address AS wallet_address, deod_amount::text AS amount, tx_hash FROM dex_swaps WHERE tx_hash = $1`, [s]),
    ]);
    return { type: 'tx' as const, results: [...f.rows, ...sw.rows] };
  }
  if (/^0x[0-9a-f]{40}$/.test(s)) {
    const { rows } = await db.query(`SELECT 1 FROM wallet_summary WHERE address = $1`, [s]);
    return { type: 'address' as const, known: rows.length > 0, address: s };
  }
  return { type: 'invalid' as const };
}

export async function addressBook(db: pg.Pool) {
  const [ex, pools] = await Promise.all([
    db.query(`SELECT a.address, a.exchange, e.name, a.address_type, a.verified, a.monitored, a.dune_label, a.notes, a.source
              FROM exchange_addresses a JOIN exchanges e ON e.slug = a.exchange ORDER BY e.name, a.address`),
    db.query(`SELECT address, version, pair, fee_tier, quote_symbol, verification FROM dex_pools ORDER BY version`),
  ]);
  return { exchangeAddresses: ex.rows, pools: pools.rows };
}

/** End of the window up to which every query is fully synced (daily sync: midnight UTC of the last completed day). */
export async function dataThrough(db: pg.Pool): Promise<Date | null> {
  const { rows } = await db.query<{ t: Date | null }>(`SELECT min(synced_until) AS t FROM dune_sync_state`);
  return rows[0]?.t ?? null;
}

export async function syncStatus(db: pg.Pool) {
  const [state, runs, rejections] = await Promise.all([
    db.query(`SELECT query_name, status, last_block_time, synced_until, last_sync_at, credits_total::text, error, backfill_from, backfill_cursor FROM dune_sync_state ORDER BY query_name`),
    db.query(`SELECT id, query_name, mode, window_start, window_end, started_at, finished_at, status, rows_fetched, rows_inserted, rows_duplicate, rows_rejected, credits::text, error FROM sync_runs ORDER BY id DESC LIMIT 25`),
    db.query(`SELECT count(*)::int AS n FROM ingest_rejections`),
  ]);
  return { queries: state.rows, recentRuns: runs.rows, rejectedRows: rejections.rows[0].n as number };
}
