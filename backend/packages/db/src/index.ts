import { MongoClient, type Db, type Document } from 'mongodb';
import { loadConfig, loadEnv, monitoredPools, type DeodConfig } from '@deod/config';
import { rawToDecimal, type SwapRow, type TransferRow } from '@deod/core';
import { toDec128, toDec128OrNull } from './decimal.js';
import { insertIgnoringDuplicates, isDuplicateKey, nextIds } from './util.js';

export { migrate, STEPS } from './migrate.js';
export * from './decimal.js';
export * from './util.js';
export { addExchanges, addFlow, addSwap, addSyncRuns, createScratchDb, setSyncedUntil, testTx, type ScratchDb, type TestFlow, type TestSwap } from './testing.js';

export type { Db };

let client: MongoClient | undefined;
let db: Db | undefined;

/** Database name from the connection string path ("mongodb://host:27018/deod_monitor" -> "deod_monitor"). */
export function databaseName(uri: string): string {
  const m = /^mongodb(?:\+srv)?:\/\/[^/]*\/([^?]*)/.exec(uri);
  return decodeURIComponent(m?.[1] ?? '') || 'deod_monitor';
}

/**
 * The shared database handle (one connection pool per process). `queryTimeoutMs` (first call only) makes the database give up on any single
 * operation that takes longer, so one bad request cannot pile up and exhaust the pool; the API passes 60 s.
 */
export function getDb(opts: { queryTimeoutMs?: number } = {}): Db {
  if (!db) {
    const uri = loadEnv().MONGODB_URI;
    // serverSelectionTimeoutMS: a query waits at most 10 s for a reachable server and then fails with an error, instead of hanging.
    client = new MongoClient(uri, { maxPoolSize: 10, serverSelectionTimeoutMS: 10_000, ...(opts.queryTimeoutMs ? { timeoutMS: opts.queryTimeoutMs } : {}) });
    // A dropped connection is re-opened by the driver on the next operation; this only keeps the event from being an unhandled 'error'.
    client.on('error', (err) => console.error(`[db] the database connection reported an error: ${err.message}`));
    db = client.db(databaseName(uri));
  }
  return db;
}

export async function closeDb() {
  await client?.close();
  client = undefined;
  db = undefined;
}

const now = () => new Date();

/** Upserts config-defined exchanges, exchange addresses and pools. Admin-added rows are left untouched. */
export async function seedFromConfig(d: Db = getDb(), cfg: DeodConfig = loadConfig()) {
  for (const [slug, ex] of Object.entries(cfg.exchanges)) {
    await d.collection('exchanges').updateOne(
      { _id: slug as never },
      { $set: { slug, name: ex.name, updated_at: now() }, $setOnInsert: { created_at: now() } },
      { upsert: true },
    );
    for (const a of ex.addresses) {
      // Only rows that came from the config are updated; an address an admin added by hand keeps its own settings.
      const updated = await d.collection('exchange_addresses').updateOne(
        { chain: 'bnb', address: a.address, source: 'config' },
        { $set: { exchange: slug, address_type: a.address_type, dune_label: a.dune_label ?? null, notes: a.note ?? null, updated_at: now() } },
      );
      if (updated.matchedCount) continue;
      try {
        await d.collection('exchange_addresses').insertOne({
          _id: (await nextIds(d, 'exchange_addresses')) as never, exchange: slug, chain: 'bnb', address: a.address, label: ex.name, address_type: a.address_type,
          source: 'config', verified: a.verified, monitored: true, dune_label: a.dune_label ?? null, notes: a.note ?? null, created_at: now(), updated_at: now(),
        });
      } catch (e) {
        if (!isDuplicateKey(e)) throw e;                                 // already there as an admin row (or inserted by a parallel start): leave it alone
      }
    }
  }
  for (const p of monitoredPools(cfg)) {
    const [quoteSymbol, deodSide] = p.token0 === cfg.token.symbol ? [p.token1, 0] : [p.token0, 1];
    const quote = cfg.quote_tokens[quoteSymbol];
    if (!quote) throw new Error(`pool ${p.address}: quote token ${quoteSymbol} missing from quote_tokens`);
    if (deodSide === 1 && p.token1 !== cfg.token.symbol) throw new Error(`pool ${p.address} does not contain ${cfg.token.symbol}`);
    await d.collection('dex_pools').updateOne(
      { _id: p.address as never },
      {
        $set: {
          address: p.address, version: p.version, pair: p.pair, quote_address: quote.address, quote_symbol: quoteSymbol, quote_decimals: quote.decimals,
          fee_tier: p.fee_tier ?? null, verification: p.verification ?? null, updated_at: now(),
        },
        $setOnInsert: { chain: 'bnb', dex: 'pancakeswap', deod_address: cfg.token.address },
      },
      { upsert: true },
    );
  }
}

export async function monitoredExchangeAddresses(d: Db = getDb()) {
  const rows = await d.collection('exchange_addresses').find({ monitored: true, chain: 'bnb' }, { projection: { exchange: 1, address: 1 } }).sort({ address: 1 }).toArray();
  return rows.map((r) => ({ exchange: r.exchange as string, address: r.address as string }));
}

const BATCH = 500;

/** Inserts transfers; duplicates (same chain+tx_hash+evt_index) are skipped. Returns the number inserted. */
export async function insertTransfers(rows: TransferRow[], tokenAddress: string, decimals: number, d: Db = getDb()) {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const first = await nextIds(d, 'token_transfers', chunk.length);
    const docs = chunk.map((r, k) => ({
      _id: first + k, chain: 'bnb', token_address: tokenAddress, tx_hash: r.txHash, evt_index: r.evtIndex, block_number: r.blockNumber,
      block_time: new Date(r.blockTime), from_address: r.fromAddress, to_address: r.toAddress, amount_raw: r.amountRaw,
      amount: toDec128(rawToDecimal(r.amountRaw, decimals)), tx_from: r.txFrom, source: 'dune:tokens.transfers', ingested_at: now(),
    }));
    inserted += await insertIgnoringDuplicates(d.collection('token_transfers'), docs as Document[]);
  }
  return inserted;
}

/**
 * (Re)derives exchange_flows from token_transfers for every monitored exchange address.
 * Idempotent; also picks up history for exchange addresses added after the transfers were ingested.
 * A transfer from one monitored address to another gives two rows, an OUT for the sender and an IN for the receiver.
 */
export async function deriveExchangeFlows(d: Db = getDb()) {
  const monitored = new Map((await monitoredExchangeAddresses(d)).map((a) => [a.address, a.exchange]));
  if (!monitored.size) return 0;
  const addrs = [...monitored.keys()];
  const flows = d.collection('exchange_flows');
  const cursor = d.collection('token_transfers')
    .find({ $or: [{ to_address: { $in: addrs } }, { from_address: { $in: addrs } }], $expr: { $ne: ['$from_address', '$to_address'] } })
    .sort({ _id: 1 }).batchSize(1000);

  let inserted = 0;
  let batch: Document[] = [];
  const flush = async () => {
    if (!batch.length) return;
    const candidates: Document[] = [];
    for (const t of batch) {
      const toEx = monitored.get(t.to_address), fromEx = monitored.get(t.from_address);
      const base = { chain: 'bnb', token_address: t.token_address, amount_raw: t.amount_raw, amount: t.amount, tx_hash: t.tx_hash, evt_index: t.evt_index, block_number: t.block_number, block_time: t.block_time };
      if (toEx) candidates.push({ ...base, exchange: toEx, direction: 'IN', wallet_address: t.from_address, exchange_address: t.to_address });
      if (fromEx) candidates.push({ ...base, exchange: fromEx, direction: 'OUT', wallet_address: t.to_address, exchange_address: t.from_address });
    }
    // Look up what is already derived for these transactions, so a repeat run takes no new ids and inserts nothing.
    const have = new Set((await flows.find({ tx_hash: { $in: [...new Set(batch.map((t) => t.tx_hash))] } }, { projection: { exchange_address: 1, tx_hash: 1, evt_index: 1, direction: 1 } }).toArray())
      .map((f) => `${f.exchange_address}|${f.tx_hash}|${f.evt_index}|${f.direction}`));
    const fresh = candidates.filter((c) => !have.has(`${c.exchange_address}|${c.tx_hash}|${c.evt_index}|${c.direction}`));
    if (fresh.length) {
      const first = await nextIds(d, 'exchange_flows', fresh.length);
      inserted += await insertIgnoringDuplicates(flows, fresh.map((c, k) => ({ _id: first + k, ...c })) as Document[]);
    }
    batch = [];
  };
  for await (const t of cursor) {
    batch.push(t);
    if (batch.length >= 1000) await flush();
  }
  await flush();
  return inserted;
}

export async function insertSwaps(
  rows: SwapRow[],
  ctx: { deodDecimals: number; quote: Map<string, { decimals: number; usdPeg: boolean; symbol: string }> },
  d: Db = getDb(),
) {
  const deodAddress = loadConfig().token.address;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const first = await nextIds(d, 'dex_swaps', chunk.length);
    const docs = chunk.map((r, k) => {
      const q = ctx.quote.get(r.quoteTokenAddress);
      if (!q) throw new Error(`quote token ${r.quoteTokenAddress} not configured`);
      const quoteAmount = rawToDecimal(r.quoteAmountRaw, q.decimals);
      // token_in = what the trader paid into the pool; token_out = what the pool paid out.
      const buy = r.side === 'BUY';
      return {
        _id: first + k, chain: 'bnb', dex: 'pancakeswap', version: r.version, pool_address: r.poolAddress, tx_hash: r.txHash, evt_index: r.evtIndex,
        block_number: r.blockNumber, block_time: new Date(r.blockTime), trader_address: r.traderAddress, recipient_address: r.recipientAddress ?? null,
        tx_to: r.txTo ?? null, side: r.side,
        token_in: buy ? r.quoteTokenAddress : deodAddress, amount_in_raw: buy ? r.quoteAmountRaw : r.deodAmountRaw,
        token_out: buy ? deodAddress : r.quoteTokenAddress, amount_out_raw: buy ? r.deodAmountRaw : r.quoteAmountRaw,
        deod_amount_raw: r.deodAmountRaw, deod_amount: toDec128(rawToDecimal(r.deodAmountRaw, ctx.deodDecimals)),
        quote_token: r.quoteTokenAddress, quote_amount_raw: r.quoteAmountRaw, quote_amount: toDec128(quoteAmount),
        price: toDec128(r.price), usd_value: q.usdPeg ? toDec128OrNull(quoteAmount) : null, usd_basis: q.usdPeg ? `${q.symbol.toLowerCase()}_peg` : null,
        source: 'dune:dex.trades', ingested_at: now(),
      };
    });
    inserted += await insertIgnoringDuplicates(d.collection('dex_swaps'), docs as Document[]);
  }
  return inserted;
}

export async function recordRejections(queryName: string, executionId: string, items: { reasons: string[]; raw: unknown }[], d: Db = getDb()) {
  if (!items.length) return;
  const first = await nextIds(d, 'ingest_rejections', items.length);
  await d.collection('ingest_rejections').insertMany(items.map((it, k) => ({
    _id: (first + k) as never, query_name: queryName, execution_id: executionId, reasons: it.reasons, raw: it.raw as Document, created_at: now(),
  })));
}

/**
 * Rebuilds wallet_summary: one document per wallet across exchange flows (as the counterparty wallet) and PancakeSwap swaps (as the trader).
 * `$out` writes a complete new collection and swaps it in atomically, so readers never see a half-built summary.
 */
export async function refreshWalletSummary(d: Db = getDb()) {
  const zero = null;
  await d.collection('exchange_flows').aggregate([
    {
      $project: {
        address: '$wallet_address', block_time: 1, tx_hash: 1, deod_amount: '$amount', transfer_amount: '$amount',
        sent: { $cond: [{ $eq: ['$direction', 'IN'] }, '$amount', zero] }, received: { $cond: [{ $eq: ['$direction', 'OUT'] }, '$amount', zero] },
        buy: { $literal: zero }, sell: { $literal: zero }, swap_amount: { $literal: zero }, swap_usd: { $literal: zero },
      },
    },
    {
      $unionWith: {
        coll: 'dex_swaps',
        pipeline: [{
          $project: {
            address: '$trader_address', block_time: 1, tx_hash: 1, deod_amount: 1, transfer_amount: { $literal: zero },
            sent: { $literal: zero }, received: { $literal: zero },
            buy: { $cond: [{ $eq: ['$side', 'BUY'] }, '$deod_amount', zero] }, sell: { $cond: [{ $eq: ['$side', 'SELL'] }, '$deod_amount', zero] },
            swap_amount: '$deod_amount', swap_usd: '$usd_value',
          },
        }],
      },
    },
    {
      $group: {
        _id: '$address', first_seen: { $min: '$block_time' }, last_seen: { $max: '$block_time' }, txs: { $addToSet: '$tx_hash' },
        total_deod_volume: { $sum: '$deod_amount' }, sent_to_exchanges: { $sum: '$sent' }, received_from_exchanges: { $sum: '$received' },
        exchange_transfer_count: { $sum: { $cond: [{ $ne: ['$transfer_amount', zero] }, 1, 0] } },
        swap_buy_deod: { $sum: '$buy' }, swap_sell_deod: { $sum: '$sell' },
        swap_count: { $sum: { $cond: [{ $ne: ['$swap_amount', zero] }, 1, 0] } }, swap_usd_volume: { $sum: '$swap_usd' },
        largest_transfer: { $max: '$transfer_amount' }, largest_swap: { $max: '$swap_amount' },
      },
    },
    {
      $project: {
        address: '$_id', first_seen: 1, last_seen: 1, transaction_count: { $size: '$txs' }, total_deod_volume: 1, sent_to_exchanges: 1, received_from_exchanges: 1,
        exchange_transfer_count: 1, swap_buy_deod: 1, swap_sell_deod: 1, swap_count: 1, swap_usd_volume: 1, largest_transfer: 1, largest_swap: 1,
      },
    },
    { $out: 'wallet_summary' },
  ], { allowDiskUse: true }).toArray();
}
