// Helper for integration tests: a THROWAWAY database on the local MongoDB server, with all collections created, dropped afterwards.
// It never touches the real database. When no server is reachable the caller gets null and skips its tests.
import { MongoClient, type Db } from 'mongodb';
import { loadEnv } from '@deod/config';
import { Decimal } from 'decimal.js';
import { migrate } from './migrate.js';
import { toDec128, toDec128OrNull } from './decimal.js';
import { nextIds } from './util.js';

export interface ScratchDb { db: Db; name: string; /** Connection string of this scratch database (set it as MONGODB_URI to make getDb() use it). */ uri: string; drop(): Promise<void> }

export async function createScratchDb(prefix = 'deod_test'): Promise<ScratchDb | null> {
  let client: MongoClient | undefined;
  try {
    const base = loadEnv().MONGODB_URI;
    client = new MongoClient(base, { serverSelectionTimeoutMS: 3000, maxPoolSize: 6 });
    await client.connect();
    const name = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const db = client.db(name);
    await migrate(db);
    const c = client;
    const uri = base.replace(/^(mongodb(?:\+srv)?:\/\/[^/]*)\/?([^?]*)/, `$1/${name}`);
    return { db, name, uri, async drop() { await db.dropDatabase().catch(() => {}); await c.close(); } };
  } catch {
    await client?.close().catch(() => {});
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Row builders for tests: documents that satisfy the collections' validation rules, with ids and exact Decimal128 amounts filled in.
// ---------------------------------------------------------------------------------------------------------------------------------
const DEOD_TOKEN = '0x3510fbbc13090f991ffa523527113a166161683e';
const USDT_TOKEN = '0x55d398326f99059ff775485246999027b3197955';
const POOL_V2 = '0xd693c42610bd30e63b0a68a25918445a5f9a1d20';
const MEXC_ADDRESS = '0x4982085c9e2f89f2ecb8131eca71afad896e89cb';
let counter = 100;
export const testTx = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const raw = (amount: string, decimals = 18) => new Decimal(amount).times(new Decimal(10).pow(decimals)).toFixed(0);

export interface TestFlow { exchange: string; direction: 'IN' | 'OUT'; wallet: string; amount: string; time: string; exchangeAddress?: string; tx?: string; evt?: number }

/** Inserts one exchange_flows row (and returns its transaction hash). */
export async function addFlow(db: Db, o: TestFlow): Promise<string> {
  const n = ++counter;
  const tx = o.tx ?? testTx(n);
  await db.collection('exchange_flows').insertOne({
    _id: (await nextIds(db, 'exchange_flows')) as never, chain: 'bnb', exchange: o.exchange, direction: o.direction, token_address: DEOD_TOKEN, wallet_address: o.wallet,
    exchange_address: o.exchangeAddress ?? MEXC_ADDRESS, amount_raw: raw(o.amount), amount: toDec128(o.amount), tx_hash: tx, evt_index: o.evt ?? 1, block_number: n, block_time: new Date(o.time),
  });
  return tx;
}

export interface TestSwap { side: 'BUY' | 'SELL'; trader: string; amount: string; time: string; version?: '2' | '3'; pool?: string; usd?: string | null; price?: string; recipient?: string | null; tx?: string }

/** Inserts one dex_swaps row (and returns its transaction hash). `usd` defaults to amount x price. */
export async function addSwap(db: Db, o: TestSwap): Promise<string> {
  const n = ++counter;
  const tx = o.tx ?? testTx(n);
  const price = o.price ?? '0.017';
  const quote = new Decimal(o.amount).times(price).toFixed(6);
  const buy = o.side === 'BUY';
  await db.collection('dex_swaps').insertOne({
    _id: (await nextIds(db, 'dex_swaps')) as never, chain: 'bnb', dex: 'pancakeswap', version: o.version ?? '2', pool_address: o.pool ?? POOL_V2, tx_hash: tx, evt_index: 1, block_number: n,
    block_time: new Date(o.time), trader_address: o.trader, recipient_address: o.recipient ?? null, tx_to: null, side: o.side,
    token_in: buy ? USDT_TOKEN : DEOD_TOKEN, amount_in_raw: buy ? raw(quote) : raw(o.amount), token_out: buy ? DEOD_TOKEN : USDT_TOKEN, amount_out_raw: buy ? raw(o.amount) : raw(quote),
    deod_amount_raw: raw(o.amount), deod_amount: toDec128(o.amount), quote_token: USDT_TOKEN, quote_amount_raw: raw(quote), quote_amount: toDec128(quote), price: toDec128(price),
    usd_value: toDec128OrNull(o.usd === undefined ? quote : o.usd), usd_basis: (o.usd === undefined ? quote : o.usd) === null ? null : 'usdt_peg', source: 'test', ingested_at: new Date(),
  });
  return tx;
}

/** Adds exchanges (slug -> name) the way seedFromConfig would, without needing the config. */
export async function addExchanges(db: Db, exchanges: Record<string, string>) {
  for (const [slug, name] of Object.entries(exchanges)) await db.collection('exchanges').insertOne({ _id: slug as never, slug, name, created_at: new Date(), updated_at: new Date() });
}

/** Sets the sync checkpoint of the given queries. */
export async function setSyncedUntil(db: Db, until: string, queries = ['exchange_transfers', 'pancakeswap_swaps']) {
  for (const q of queries) await db.collection('dune_sync_state').updateOne({ _id: q as never }, { $set: { query_name: q, status: 'ok', synced_until: new Date(until) } }, { upsert: true });
}

/** Records one "use" of a sync: one sync_runs row per query, started at `at` (ISO time). */
export async function addSyncRuns(db: Db, at: string, mode: string, status = 'ok', queries = ['exchange_transfers', 'pancakeswap_swaps']) {
  for (const q of queries) {
    await db.collection('sync_runs').insertOne({
      _id: (await nextIds(db, 'sync_runs')) as never, query_name: q, mode, window_start: new Date(at), window_end: new Date(at), started_at: new Date(at), finished_at: null, status,
    });
  }
}
