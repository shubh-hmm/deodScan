import type { Db, Document } from 'mongodb';
import { z } from 'zod';
import { decStr, decStrOrNull, plainStr, toBound, toDecimal } from '@deod/db';

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

/**
 * The end of the newest data that was fetched: the latest finished sync window (daily or "today so far"). Data arrives in batches, so the short
 * periods (1h, 6h, 24h) count back from this moment instead of from the clock; otherwise they would often fall entirely into the not-yet-fetched gap.
 * Null when nothing was synced yet.
 */
export async function dataAnchor(db: Db): Promise<Date | null> {
  const r = await db.collection('sync_runs').find({ status: 'ok' }, { projection: { window_end: 1 } }).sort({ window_end: -1 }).limit(1).next();
  return (r?.window_end as Date | undefined) ?? null;
}

const SHORT = new Set(['1h', '6h', '24h']);

export function resolveWindow(q: z.infer<typeof RangeQuery>, now = new Date(), anchor: Date | null = null): Window {
  let from: Date | null;
  let to = now;
  if (SHORT.has(q.range) && anchor && anchor < now) { now = anchor; to = anchor; }
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
/** The time part of a filter: block_time in [from, to). */
const inWindow = (w: Window): Document => ({ block_time: { $gte: lo(w), $lt: w.to } });

// ---------------------------------------------------------------------------
// Aggregation building blocks
// ---------------------------------------------------------------------------

/** $sum of `field` over documents where `cond` holds. */
const sumWhen = (cond: Document, field = '$amount'): Document => ({ $sum: { $cond: [cond, field, 0] } });
/** Number of documents where `cond` holds. */
const countWhen = (cond: Document): Document => ({ $sum: { $cond: [cond, 1, 0] } });
/** Largest `field` where `cond` holds (null when none). */
const maxWhen = (cond: Document, field = '$amount'): Document => ({ $max: { $cond: [cond, field, null] } });
/** Distinct values of `field` where `cond` holds (collect with the null stand-in, drop it again in sizeOfSet). */
const setWhen = (cond: Document, field: string): Document => ({ $addToSet: { $cond: [cond, field, null] } });
const sizeOfSet = (name: string): Document => ({ $size: { $setDifference: [`$${name}`, [null]] } });
const isDir = (d: 'IN' | 'OUT'): Document => ({ $eq: ['$direction', d] });
const isSide = (s: 'BUY' | 'SELL'): Document => ({ $eq: ['$side', s] });

const first = async (d: Db, collection: string, pipeline: Document[]): Promise<Document | undefined> =>
  (await d.collection(collection).aggregate(pipeline, { allowDiskUse: true }).toArray())[0];

/** Decimal sums -> API strings, "0" when nothing matched. */
const sumStr = (v: unknown) => decStr(v ?? 0);

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export async function overview(db: Db, w: Window) {
  const tm = inWindow(w);
  const [exchanges, byExchange, totals, uniqueWallets, transfers, swaps] = await Promise.all([
    db.collection('exchanges').find().sort({ name: 1 }).toArray(),
    db.collection('exchange_flows').aggregate([
      { $match: tm },
      { $group: { _id: '$exchange', inflow: sumWhen(isDir('IN')), outflow: sumWhen(isDir('OUT')), deposits: countWhen(isDir('IN')), withdrawals: countWhen(isDir('OUT')), wallets: { $addToSet: '$wallet_address' } } },
    ]).toArray(),
    first(db, 'exchange_flows', [{ $match: tm }, { $group: { _id: null, inflow: sumWhen(isDir('IN')), outflow: sumWhen(isDir('OUT')) } }]),
    first(db, 'exchange_flows', [
      { $match: tm }, { $project: { addr: '$wallet_address' } },
      { $unionWith: { coll: 'dex_swaps', pipeline: [{ $match: tm }, { $project: { addr: '$trader_address' } }] } },
      { $group: { _id: '$addr' } }, { $count: 'n' },
    ]),
    db.collection('token_transfers').countDocuments(tm),
    pancakeStats(db, w, 'all'),
  ]);
  const flows = new Map(byExchange.map((r) => [r._id as unknown as string, r]));
  const rows = exchanges.map((e) => {
    const f = flows.get(e._id as unknown as string);
    const inflow = toDecimal(f?.inflow ?? 0), outflow = toDecimal(f?.outflow ?? 0);
    return {
      exchange: e._id as unknown as string, name: e.name as string, inflow: sumStr(inflow), outflow: sumStr(outflow), net: sumStr(inflow.minus(outflow)),
      deposits: (f?.deposits as number) ?? 0, withdrawals: (f?.withdrawals as number) ?? 0, unique_wallets: (f?.wallets as string[] | undefined)?.length ?? 0,
    };
  });
  const inflow = toDecimal(totals?.inflow ?? 0), outflow = toDecimal(totals?.outflow ?? 0);
  return {
    window: w,
    exchanges: rows,
    totals: {
      inflow: sumStr(inflow), outflow: sumStr(outflow), net: sumStr(inflow.minus(outflow)),
      uniqueWallets: (uniqueWallets?.n as number) ?? 0,
      exchangeTransfers: transfers,
    },
    pancakeswap: swaps,
  };
}

// ---------------------------------------------------------------------------
// Exchange flows
// ---------------------------------------------------------------------------

export async function exchangeStats(db: Db, exchange: string, w: Window) {
  const r = await first(db, 'exchange_flows', [
    { $match: { exchange, ...inWindow(w) } },
    {
      $group: {
        _id: null, inflow: sumWhen(isDir('IN')), outflow: sumWhen(isDir('OUT')), deposits: countWhen(isDir('IN')), withdrawals: countWhen(isDir('OUT')),
        ins: setWhen(isDir('IN'), '$wallet_address'), outs: setWhen(isDir('OUT'), '$wallet_address'), all: { $addToSet: '$wallet_address' },
        largest_deposit: maxWhen(isDir('IN')), largest_withdrawal: maxWhen(isDir('OUT')),
      },
    },
    { $project: { inflow: 1, outflow: 1, deposits: 1, withdrawals: 1, unique_depositors: sizeOfSet('ins'), unique_withdrawers: sizeOfSet('outs'), unique_wallets: { $size: '$all' }, largest_deposit: 1, largest_withdrawal: 1 } },
  ]);
  const inflow = toDecimal(r?.inflow ?? 0), outflow = toDecimal(r?.outflow ?? 0);
  return {
    inflow: sumStr(inflow), outflow: sumStr(outflow), net: sumStr(inflow.minus(outflow)),
    deposits: r?.deposits ?? 0, withdrawals: r?.withdrawals ?? 0,
    unique_depositors: r?.unique_depositors ?? 0, unique_withdrawers: r?.unique_withdrawers ?? 0, unique_wallets: r?.unique_wallets ?? 0,
    largest_deposit: decStrOrNull(r?.largest_deposit), largest_withdrawal: decStrOrNull(r?.largest_withdrawal),
  };
}

/** Bucketed IN/OUT per exchange. Empty buckets are omitted; the chart fills gaps. */
export async function flowSeries(db: Db, w: Window, exchange?: string) {
  const rows = await db.collection('exchange_flows').aggregate([
    { $match: { ...inWindow(w), ...(exchange ? { exchange } : {}) } },
    { $group: { _id: { bucket: { $dateTrunc: { date: '$block_time', unit: w.bucket, timezone: 'UTC' } }, exchange: '$exchange' }, inflow: sumWhen(isDir('IN')), outflow: sumWhen(isDir('OUT')) } },
    { $sort: { '_id.bucket': 1, '_id.exchange': 1 } },
  ]).toArray();
  return rows.map((r) => ({ bucket: r._id.bucket as Date, exchange: r._id.exchange as string, inflow: sumStr(r.inflow), outflow: sumStr(r.outflow) }));
}

/** Exchange transfers per UTC hour of day (0-23) in the window, split IN / OUT. Hours with no activity are returned as zeros. */
export async function hourlyActivity(db: Db, w: Window) {
  const rows = await db.collection('exchange_flows').aggregate([
    { $match: inWindow(w) },
    { $group: { _id: { $hour: { date: '$block_time', timezone: 'UTC' } }, inflows: countWhen(isDir('IN')), outflows: countWhen(isDir('OUT')) } },
  ]).toArray();
  const byHour = new Map(rows.map((r) => [r._id as unknown as number, r]));
  return Array.from({ length: 24 }, (_, hour) => ({ hour, inflows: (byHour.get(hour)?.inflows as number) ?? 0, outflows: (byHour.get(hour)?.outflows as number) ?? 0 }));
}

const flowActivity = (f: Document) => ({
  block_time: f.block_time as Date, type: 'exchange', venue: f.exchange as string, action: f.direction as string, wallet_address: f.wallet_address as string,
  counterparty: f.exchange_address as string, deod_amount: decStr(f.amount), quote_amount: null as string | null, price: null as string | null, usd_value: null as string | null,
  tx_hash: f.tx_hash as string, evt_index: f.evt_index as number, block_number: f.block_number as number,
});
const swapActivity = (s: Document) => ({
  block_time: s.block_time as Date, type: 'swap', venue: `pancakeswap_v${s.version}`, action: s.side as string, wallet_address: s.trader_address as string,
  counterparty: s.pool_address as string, deod_amount: decStr(s.deod_amount), quote_amount: decStr(s.quote_amount) as string | null, price: decStr(s.price, 30) as string | null,
  usd_value: decStrOrNull(s.usd_value), tx_hash: s.tx_hash as string, evt_index: s.evt_index as number, block_number: s.block_number as number,
});
const newestFirst = (a: { block_time: Date; evt_index: number }, b: { block_time: Date; evt_index: number }) =>
  b.block_time.getTime() - a.block_time.getTime() || b.evt_index - a.evt_index;
const NEWEST: Document = { block_time: -1, evt_index: -1, _id: -1 };

/**
 * Every monitored transaction in the window, newest first: exchange transfers (type "exchange") and PancakeSwap swaps
 * (type "swap") in one list with common columns. wallet_address is the counterparty wallet for an exchange transfer and the
 * transaction signer for a swap; counterparty is the exchange address or the pool. Quote/price/USD columns are empty for transfers.
 */
export async function listActivity(db: Db, w: Window, limit: number) {
  const tm = inWindow(w);
  const [flows, swaps] = await Promise.all([
    db.collection('exchange_flows').find(tm).sort(NEWEST).limit(limit).toArray(),
    db.collection('dex_swaps').find(tm).sort(NEWEST).limit(limit).toArray(),
  ]);
  return [...flows.map(flowActivity), ...swaps.map(swapActivity)].sort(newestFirst).slice(0, limit);
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

/** amount >= min and/or amount <= max as a database filter on `field`. */
function amountRange(field: string, min?: number, max?: number): Document {
  if (min === undefined && max === undefined) return {};
  return { [field]: { ...(min !== undefined ? { $gte: toBound(min) } : {}), ...(max !== undefined ? { $lte: toBound(max) } : {}) } };
}

export async function listFlows(db: Db, w: Window, f: z.infer<typeof FlowFilter>) {
  const filter: Document = {
    ...inWindow(w), ...(f.exchange ? { exchange: f.exchange } : {}), ...(f.direction ? { direction: f.direction } : {}),
    ...(f.wallet ? { wallet_address: f.wallet } : {}), ...amountRange('amount', f.min, f.max),
  };
  // Sorted on the Decimal128 value itself, so 1,270,524.83 ranks above 9.9 (the old SQL once sorted the text form by mistake).
  const sort: Document = f.sort === 'amount' ? { amount: -1, block_time: -1, _id: -1 } : NEWEST;
  const col = db.collection('exchange_flows');
  const [rows, total] = await Promise.all([col.find(filter).sort(sort).skip(f.offset).limit(f.limit).toArray(), col.countDocuments(filter)]);
  return {
    total,
    rows: rows.map((r) => ({
      block_time: r.block_time as Date, exchange: r.exchange as string, direction: r.direction as string, wallet_address: r.wallet_address as string,
      exchange_address: r.exchange_address as string, amount: decStr(r.amount), amount_raw: r.amount_raw as string, tx_hash: r.tx_hash as string,
      evt_index: r.evt_index as number, block_number: r.block_number as number,
    })),
  };
}

export async function topExchangeWallets(db: Db, exchange: string, direction: 'IN' | 'OUT', w: Window, limit = 25) {
  const rows = await db.collection('exchange_flows').aggregate([
    { $match: { exchange, direction, ...inWindow(w) } },
    { $group: { _id: '$wallet_address', total: { $sum: '$amount' }, transfers: { $sum: 1 }, largest: { $max: '$amount' }, first_seen: { $min: '$block_time' }, last_seen: { $max: '$block_time' } } },
    { $sort: { total: -1, _id: 1 } }, { $limit: limit },
  ], { allowDiskUse: true }).toArray();
  return rows.map((r) => ({ wallet_address: r._id as unknown as string, total: decStr(r.total), transfers: r.transfers as number, largest: decStr(r.largest), first_seen: r.first_seen as Date, last_seen: r.last_seen as Date }));
}

// ---------------------------------------------------------------------------
// PancakeSwap
// ---------------------------------------------------------------------------

export type VersionSel = '2' | '3' | 'all';

export async function pancakeStats(db: Db, w: Window, version: VersionSel) {
  const match: Document = { ...inWindow(w), ...(version === 'all' ? {} : { version }) };
  const [r, last] = await Promise.all([
    first(db, 'dex_swaps', [
      { $match: match },
      {
        $group: {
          _id: null, deod_volume: { $sum: '$deod_amount' }, buy_deod: sumWhen(isSide('BUY'), '$deod_amount'), sell_deod: sumWhen(isSide('SELL'), '$deod_amount'),
          usd_volume: { $sum: '$usd_value' }, buy_usd: sumWhen(isSide('BUY'), '$usd_value'), sell_usd: sumWhen(isSide('SELL'), '$usd_value'),
          swaps: { $sum: 1 }, buys: countWhen(isSide('BUY')), sells: countWhen(isSide('SELL')), wallets: { $addToSet: '$trader_address' },
          largest_swap_deod: { $max: '$deod_amount' }, last_swap_time: { $max: '$block_time' },
        },
      },
    ]),
    db.collection('dex_swaps').find(match, { projection: { price: 1 } }).sort({ block_number: -1, evt_index: -1, _id: -1 }).limit(1).next(),
  ]);
  return {
    deod_volume: sumStr(r?.deod_volume), buy_deod: sumStr(r?.buy_deod), sell_deod: sumStr(r?.sell_deod),
    usd_volume: sumStr(r?.usd_volume), buy_usd: sumStr(r?.buy_usd), sell_usd: sumStr(r?.sell_usd),
    swaps: (r?.swaps as number) ?? 0, buys: (r?.buys as number) ?? 0, sells: (r?.sells as number) ?? 0, unique_wallets: (r?.wallets as string[] | undefined)?.length ?? 0,
    largest_swap_deod: decStrOrNull(r?.largest_swap_deod), last_price: last ? decStr(last.price, 30) : null, last_swap_time: (r?.last_swap_time as Date | undefined) ?? null,
  };
}

export async function swapSeries(db: Db, w: Window, version: VersionSel) {
  const rows = await db.collection('dex_swaps').aggregate([
    { $match: { ...inWindow(w), ...(version === 'all' ? {} : { version }) } },
    {
      $group: {
        _id: { bucket: { $dateTrunc: { date: '$block_time', unit: w.bucket, timezone: 'UTC' } }, version: '$version' },
        buy_deod: sumWhen(isSide('BUY'), '$deod_amount'), sell_deod: sumWhen(isSide('SELL'), '$deod_amount'), usd_volume: { $sum: '$usd_value' }, swaps: { $sum: 1 },
      },
    },
    { $sort: { '_id.bucket': 1, '_id.version': 1 } },
  ]).toArray();
  return rows.map((r) => ({ bucket: r._id.bucket as Date, version: r._id.version as string, buy_deod: sumStr(r.buy_deod), sell_deod: sumStr(r.sell_deod), usd_volume: sumStr(r.usd_volume), swaps: r.swaps as number }));
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

export async function listSwaps(db: Db, w: Window, f: z.infer<typeof SwapFilter>) {
  const filter: Document = {
    ...inWindow(w), ...(f.version === 'all' ? {} : { version: f.version }), ...(f.side ? { side: f.side } : {}),
    ...(f.wallet ? { trader_address: f.wallet } : {}), ...amountRange('deod_amount', f.min, f.max),
  };
  const sort: Document = f.sort === 'amount' ? { deod_amount: -1, block_time: -1, _id: -1 } : NEWEST;
  const col = db.collection('dex_swaps');
  const [rows, total] = await Promise.all([col.find(filter).sort(sort).skip(f.offset).limit(f.limit).toArray(), col.countDocuments(filter)]);
  return {
    total,
    rows: rows.map((r) => ({
      block_time: r.block_time as Date, version: r.version as string, pool_address: r.pool_address as string, side: r.side as string, trader_address: r.trader_address as string,
      recipient_address: (r.recipient_address as string | null) ?? null, deod_amount: decStr(r.deod_amount), quote_amount: decStr(r.quote_amount), price: decStr(r.price, 30),
      usd_value: decStrOrNull(r.usd_value), usd_basis: (r.usd_basis as string | null) ?? null, tx_hash: r.tx_hash as string, evt_index: r.evt_index as number, block_number: r.block_number as number,
    })),
  };
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

const SORT_FIELD: Record<z.infer<typeof TopWalletQuery>['sort'], string> = {
  volume: 'volume', transactions: 'transactions', largest: 'largest',
  sent_to_exchanges: 'sent_to_exchanges', received_from_exchanges: 'received_from_exchanges',
  buy: 'swap_buy', sell: 'swap_sell',
};

export async function topWallets(db: Db, w: Window, q: z.infer<typeof TopWalletQuery>) {
  const tm = inWindow(w);
  // Which collections feed the ranking: a source is "all", "pancakeswap" (both pools), "pancakeswap_v2" / "_v3", or one exchange slug.
  const isPancake = q.source === 'pancakeswap' || q.source.startsWith('pancakeswap_v');
  const useFlows = q.source === 'all' || !isPancake;
  const useSwaps = q.source === 'all' || isPancake;
  const flowMatch: Document = { ...tm, ...(q.source === 'all' ? {} : { exchange: q.source }) };
  const swapMatch: Document = { ...tm, ...(q.source === 'pancakeswap_v2' ? { version: '2' } : q.source === 'pancakeswap_v3' ? { version: '3' } : {}) };
  const flowProject: Document = { $project: { addr: '$wallet_address', tx_hash: 1, block_time: 1, amount: 1, kind: { $literal: 'flow' }, dir: '$direction' } };
  const swapProject: Document = { $project: { addr: '$trader_address', tx_hash: 1, block_time: 1, amount: '$deod_amount', kind: { $literal: 'swap' }, dir: '$side' } };
  const kindDir = (kind: string, dir: string): Document => ({ $and: [{ $eq: ['$kind', kind] }, { $eq: ['$dir', dir] }] });

  const head: Document[] = useFlows
    ? [{ $match: flowMatch }, flowProject, ...(useSwaps ? [{ $unionWith: { coll: 'dex_swaps', pipeline: [{ $match: swapMatch }, swapProject] } }] : [])]
    : [{ $match: swapMatch }, swapProject];
  const having: Document = {
    ...(q.minVolume !== undefined ? { volume: { $gte: toBound(q.minVolume) } } : {}),
    ...(q.minTx !== undefined ? { transactions: { $gte: q.minTx } } : {}),
  };
  const sortField = SORT_FIELD[q.sort];
  const collection = useFlows ? 'exchange_flows' : 'dex_swaps';
  const rows = await db.collection(collection).aggregate([
    ...head,
    {
      $group: {
        _id: '$addr', volume: { $sum: '$amount' }, txs: { $addToSet: '$tx_hash' }, largest: { $max: '$amount' },
        sent_to_exchanges: sumWhen(kindDir('flow', 'IN')), received_from_exchanges: sumWhen(kindDir('flow', 'OUT')),
        swap_buy: sumWhen(kindDir('swap', 'BUY')), swap_sell: sumWhen(kindDir('swap', 'SELL')),
        first_seen: { $min: '$block_time' }, last_seen: { $max: '$block_time' },
      },
    },
    { $addFields: { transactions: { $size: '$txs' } } },
    ...(Object.keys(having).length ? [{ $match: having }] : []),
    { $sort: { [sortField]: -1, _id: 1 } },
    { $limit: q.limit },
  ], { allowDiskUse: true }).toArray();
  return rows.map((r) => ({
    wallet_address: r._id as unknown as string, volume: decStr(r.volume), transactions: r.transactions as number, largest: decStr(r.largest),
    sent_to_exchanges: decStr(r.sent_to_exchanges), received_from_exchanges: decStr(r.received_from_exchanges),
    swap_buy: decStr(r.swap_buy), swap_sell: decStr(r.swap_sell), first_seen: r.first_seen as Date, last_seen: r.last_seen as Date,
  }));
}

export async function walletProfile(db: Db, address: string) {
  const [summary, exchanges, swaps, asRecipient] = await Promise.all([
    db.collection('wallet_summary').findOne({ _id: address as never }),
    db.collection('exchange_flows').aggregate([
      { $match: { wallet_address: address } },
      { $group: { _id: { exchange: '$exchange', direction: '$direction' }, total: { $sum: '$amount' }, transfers: { $sum: 1 }, largest: { $max: '$amount' }, first_seen: { $min: '$block_time' }, last_seen: { $max: '$block_time' } } },
      { $sort: { '_id.exchange': 1, '_id.direction': 1 } },
    ]).toArray(),
    db.collection('dex_swaps').aggregate([
      { $match: { trader_address: address } },
      { $group: { _id: { version: '$version', side: '$side' }, deod: { $sum: '$deod_amount' }, usd: { $sum: '$usd_value' }, swaps: { $sum: 1 }, largest: { $max: '$deod_amount' } } },
      { $sort: { '_id.version': 1, '_id.side': 1 } },
    ]).toArray(),
    db.collection('dex_swaps').countDocuments({ recipient_address: address, trader_address: { $ne: address } }),
  ]);
  return {
    address,
    summary: summary ? {
      address, first_seen: summary.first_seen as Date, last_seen: summary.last_seen as Date, transaction_count: summary.transaction_count as number,
      total_deod_volume: decStr(summary.total_deod_volume), sent_to_exchanges: decStr(summary.sent_to_exchanges), received_from_exchanges: decStr(summary.received_from_exchanges),
      exchange_transfer_count: summary.exchange_transfer_count as number, swap_buy_deod: decStr(summary.swap_buy_deod), swap_sell_deod: decStr(summary.swap_sell_deod),
      swap_count: summary.swap_count as number, swap_usd_volume: decStr(summary.swap_usd_volume), largest_transfer: decStrOrNull(summary.largest_transfer), largest_swap: decStrOrNull(summary.largest_swap),
    } : null,
    exchanges: exchanges.map((r) => ({ exchange: r._id.exchange as string, direction: r._id.direction as string, total: decStr(r.total), transfers: r.transfers as number, largest: decStr(r.largest), first_seen: r.first_seen as Date, last_seen: r.last_seen as Date })),
    swaps: swaps.map((r) => ({ version: r._id.version as string, side: r._id.side as string, deod: decStr(r.deod), usd: decStr(r.usd), swaps: r.swaps as number, largest: decStr(r.largest) })),
    swapsAsRecipientOnly: asRecipient,
  };
}

export async function walletTimeline(db: Db, address: string, limit = 200, offset = 0) {
  const need = offset + limit;
  const [flows, swaps] = await Promise.all([
    db.collection('exchange_flows').find({ wallet_address: address }).sort(NEWEST).limit(need).toArray(),
    db.collection('dex_swaps').find({ trader_address: address }).sort(NEWEST).limit(need).toArray(),
  ]);
  const merged = [
    ...flows.map((f) => ({
      block_time: f.block_time as Date, kind: 'exchange', venue: f.exchange as string, action: f.direction as string, deod_amount: decStr(f.amount),
      usd_value: null as string | null, counterparty: f.exchange_address as string, tx_hash: f.tx_hash as string, evt_index: f.evt_index as number, block_number: f.block_number as number,
    })),
    ...swaps.map((s) => ({
      block_time: s.block_time as Date, kind: 'swap', venue: `pancakeswap_v${s.version}`, action: s.side as string, deod_amount: decStr(s.deod_amount),
      usd_value: decStrOrNull(s.usd_value), counterparty: s.pool_address as string, tx_hash: s.tx_hash as string, evt_index: s.evt_index as number, block_number: s.block_number as number,
    })),
  ];
  return merged.sort(newestFirst).slice(offset, offset + limit);
}

// ---------------------------------------------------------------------------
// Search, labels, sync status
// ---------------------------------------------------------------------------

export async function search(db: Db, q: string) {
  const s = q.trim().toLowerCase();
  if (/^0x[0-9a-f]{64}$/.test(s)) {
    const [f, sw] = await Promise.all([
      db.collection('exchange_flows').find({ tx_hash: s }).toArray(),
      db.collection('dex_swaps').find({ tx_hash: s }).toArray(),
    ]);
    return {
      type: 'tx' as const,
      results: [
        ...f.map((r) => ({ kind: 'flow', block_time: r.block_time as Date, venue: r.exchange as string, action: r.direction as string, wallet_address: r.wallet_address as string, amount: decStr(r.amount), tx_hash: r.tx_hash as string })),
        ...sw.map((r) => ({ kind: 'swap', block_time: r.block_time as Date, venue: `pancakeswap_v${r.version}`, action: r.side as string, wallet_address: r.trader_address as string, amount: decStr(r.deod_amount), tx_hash: r.tx_hash as string })),
      ],
    };
  }
  if (/^0x[0-9a-f]{40}$/.test(s)) {
    const known = (await db.collection('wallet_summary').countDocuments({ _id: s as never }, { limit: 1 })) > 0;
    return { type: 'address' as const, known, address: s };
  }
  return { type: 'invalid' as const };
}

export async function addressBook(db: Db) {
  const [exchanges, addresses, pools] = await Promise.all([
    db.collection('exchanges').find().toArray(),
    db.collection('exchange_addresses').find().toArray(),
    db.collection('dex_pools').find().sort({ version: 1 }).toArray(),
  ]);
  const names = new Map(exchanges.map((e) => [e._id as unknown as string, e.name as string]));
  const rows = addresses
    .filter((a) => names.has(a.exchange))
    .map((a) => ({
      address: a.address as string, exchange: a.exchange as string, name: names.get(a.exchange)!, address_type: a.address_type as string, verified: a.verified as boolean,
      monitored: a.monitored as boolean, dune_label: (a.dune_label as string | null) ?? null, notes: (a.notes as string | null) ?? null, source: a.source as string,
    }))
    .sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : x.address < y.address ? -1 : 1));
  return {
    exchangeAddresses: rows,
    pools: pools.map((p) => ({ address: p.address as string, version: p.version as string, pair: p.pair as string, fee_tier: (p.fee_tier as number | null) ?? null, quote_symbol: p.quote_symbol as string, verification: (p.verification as string | null) ?? null })),
  };
}

/** End of the window up to which every query is fully synced (daily sync: midnight UTC of the last completed day). */
export async function dataThrough(db: Db): Promise<Date | null> {
  const r = await first(db, 'dune_sync_state', [{ $group: { _id: null, t: { $min: '$synced_until' } } }]);
  return (r?.t as Date | null | undefined) ?? null;
}

export async function syncStatus(db: Db) {
  const [state, runs, rejected] = await Promise.all([
    db.collection('dune_sync_state').find().sort({ _id: 1 }).toArray(),
    db.collection('sync_runs').find().sort({ _id: -1 }).limit(25).toArray(),
    db.collection('ingest_rejections').countDocuments(),
  ]);
  return {
    queries: state.map((s) => ({
      query_name: s._id as unknown as string, status: s.status as string, last_block_time: (s.last_block_time as Date | null) ?? null, synced_until: (s.synced_until as Date | null) ?? null,
      last_sync_at: (s.last_sync_at as Date | null) ?? null, credits_total: plainStr(s.credits_total ?? 0), error: (s.error as string | null) ?? null,
      backfill_from: (s.backfill_from as Date | null) ?? null, backfill_cursor: (s.backfill_cursor as Date | null) ?? null,
    })),
    recentRuns: runs.map((r) => ({
      id: r._id as unknown as number, query_name: r.query_name as string, mode: r.mode as string, window_start: r.window_start as Date, window_end: r.window_end as Date, started_at: r.started_at as Date,
      finished_at: (r.finished_at as Date | null) ?? null, status: r.status as string, rows_fetched: (r.rows_fetched as number | null) ?? null, rows_inserted: (r.rows_inserted as number | null) ?? null,
      rows_duplicate: (r.rows_duplicate as number | null) ?? null, rows_rejected: (r.rows_rejected as number | null) ?? null, credits: plainStr(r.credits), error: (r.error as string | null) ?? null,
    })),
    rejectedRows: rejected,
  };
}

export * from './alerts.js';
export * from './summary.js';
