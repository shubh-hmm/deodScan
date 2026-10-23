// Database structure for MongoDB: collections, validation rules and indexes. Replaces the SQL files that used to live in ../migrations.
//
// Every step is idempotent (creating what exists is a no-op), and the names applied are recorded in `schema_migrations`, so a step runs once.
// The validators are the old CHECK constraints: a document that breaks them (wrong chain, malformed address, unknown side ...) is refused by the
// database itself, whatever code tried to write it.
import type { Db, Document, IndexDescription } from 'mongodb';
import { isDuplicateKey } from './util.js';

const ADDRESS = '^0x[0-9a-f]{40}$';
const TX_HASH = '^0x[0-9a-f]{64}$';
const str = { bsonType: 'string' };
const strOrNull = { bsonType: ['string', 'null'] };
const addr = { bsonType: 'string', pattern: ADDRESS };
const date = { bsonType: 'date' };
const dec = { bsonType: 'decimal' };
const decOrNull = { bsonType: ['decimal', 'null'] };
const num = { bsonType: 'number' };
const bool = { bsonType: 'bool' };
const bnb = { enum: ['bnb'] };

function schema(required: string[], properties: Record<string, Document>): Document {
  return { $jsonSchema: { bsonType: 'object', required, properties } };
}

/** Creates the collection with its validator, or updates the validator when it already exists. */
async function ensureCollection(db: Db, name: string, validator?: Document) {
  const exists = (await db.listCollections({ name }, { nameOnly: true }).toArray()).length > 0;
  if (!exists) {
    try {
      await db.createCollection(name, validator ? { validator, validationLevel: 'strict', validationAction: 'error' } : {});
      return;
    } catch (e) {
      if ((e as { code?: number }).code !== 48) throw e;               // 48 = NamespaceExists: the API and the worker started at the same moment
    }
  }
  if (validator) await db.command({ collMod: name, validator, validationLevel: 'strict', validationAction: 'error' });
}

async function ensureIndexes(db: Db, name: string, indexes: IndexDescription[]) {
  if (indexes.length) await db.collection(name).createIndexes(indexes);
}

interface Step { name: string; up(db: Db): Promise<void> }

export const STEPS: Step[] = [
  {
    name: '001_core_collections',
    async up(db) {
      await ensureCollection(db, 'exchanges', schema(['_id', 'slug', 'name'], { slug: { bsonType: 'string', pattern: '^[a-z0-9_]+$' }, name: str }));
      await ensureCollection(db, 'exchange_addresses', schema(['_id', 'exchange', 'chain', 'address', 'address_type', 'source', 'verified', 'monitored'], {
        exchange: str, chain: bnb, address: addr, address_type: str, source: str, verified: bool, monitored: bool,
      }));
      await ensureIndexes(db, 'exchange_addresses', [{ key: { chain: 1, address: 1 }, unique: true, name: 'chain_address_unique' }]);

      await ensureCollection(db, 'dex_pools', schema(['_id', 'address', 'chain', 'version', 'pair', 'deod_address', 'quote_address', 'quote_symbol', 'quote_decimals'], {
        address: addr, chain: bnb, version: { enum: ['2', '3'] }, pair: str, deod_address: str, quote_address: str, quote_symbol: str, quote_decimals: num,
      }));

      // Raw DEOD transfers that touch a monitored exchange address. amount_raw is the exact on-chain integer as a digit string.
      await ensureCollection(db, 'token_transfers', schema(['_id', 'chain', 'token_address', 'tx_hash', 'evt_index', 'block_number', 'block_time', 'from_address', 'to_address', 'amount_raw', 'amount'], {
        chain: bnb, tx_hash: { bsonType: 'string', pattern: TX_HASH }, evt_index: { bsonType: 'number', minimum: 0 }, block_number: { bsonType: 'number', minimum: 1 },
        block_time: date, from_address: str, to_address: str, amount_raw: { bsonType: 'string', pattern: '^[0-9]+$' }, amount: dec,
      }));
      await ensureIndexes(db, 'token_transfers', [
        { key: { chain: 1, tx_hash: 1, evt_index: 1 }, unique: true, name: 'tx_event_unique' },
        { key: { block_time: 1 }, name: 'time' }, { key: { from_address: 1 }, name: 'from' }, { key: { to_address: 1 }, name: 'to' },
      ]);

      await ensureCollection(db, 'exchange_flows', schema(['_id', 'chain', 'exchange', 'direction', 'wallet_address', 'exchange_address', 'amount_raw', 'amount', 'tx_hash', 'evt_index', 'block_number', 'block_time'], {
        chain: bnb, exchange: str, direction: { enum: ['IN', 'OUT'] }, wallet_address: str, exchange_address: str,
        amount_raw: { bsonType: 'string', pattern: '^[0-9]+$' }, amount: dec, tx_hash: str, evt_index: num, block_number: num, block_time: date,
      }));
      await ensureIndexes(db, 'exchange_flows', [
        { key: { exchange_address: 1, tx_hash: 1, evt_index: 1, direction: 1 }, unique: true, name: 'flow_unique' },
        { key: { exchange: 1, block_time: 1 }, name: 'exchange_time' }, { key: { wallet_address: 1, block_time: 1 }, name: 'wallet_time' },
        { key: { block_time: 1 }, name: 'time' }, { key: { amount: 1 }, name: 'amount' }, { key: { tx_hash: 1 }, name: 'tx' },
      ]);

      await ensureCollection(db, 'dex_swaps', schema([
        '_id', 'chain', 'version', 'pool_address', 'tx_hash', 'evt_index', 'block_number', 'block_time', 'trader_address', 'side', 'token_in', 'amount_in_raw',
        'token_out', 'amount_out_raw', 'deod_amount_raw', 'deod_amount', 'quote_token', 'quote_amount_raw', 'quote_amount', 'price',
      ], {
        chain: bnb, version: { enum: ['2', '3'] }, pool_address: str, tx_hash: { bsonType: 'string', pattern: TX_HASH }, evt_index: { bsonType: 'number', minimum: 0 },
        block_number: num, block_time: date, trader_address: str, recipient_address: strOrNull, tx_to: strOrNull, side: { enum: ['BUY', 'SELL'] },
        token_in: str, token_out: str, amount_in_raw: str, amount_out_raw: str, deod_amount_raw: str, deod_amount: dec,
        quote_token: str, quote_amount_raw: str, quote_amount: dec, price: dec, usd_value: decOrNull, usd_basis: strOrNull,
      }));
      await ensureIndexes(db, 'dex_swaps', [
        { key: { chain: 1, tx_hash: 1, evt_index: 1 }, unique: true, name: 'tx_event_unique' },
        { key: { block_time: 1 }, name: 'time' }, { key: { version: 1, block_time: 1 }, name: 'version_time' },
        { key: { trader_address: 1, block_time: 1 }, name: 'trader_time' }, { key: { deod_amount: 1 }, name: 'deod_amount' },
        { key: { tx_hash: 1 }, name: 'tx' }, { key: { recipient_address: 1 }, name: 'recipient' },
      ]);

      await ensureCollection(db, 'dune_sync_state');                  // one document per logical Dune query (_id = query name)
      await ensureCollection(db, 'sync_runs');                        // audit trail of every Dune execution the worker made
      await ensureIndexes(db, 'sync_runs', [{ key: { query_name: 1, started_at: -1 }, name: 'query_started' }, { key: { mode: 1, started_at: -1 }, name: 'mode_started' }]);
      await ensureCollection(db, 'ingest_rejections');                // malformed rows are recorded here, never silently dropped

      // Wallet-centric summary (was a materialized view). Rebuilt by refreshWalletSummary(); _id = wallet address.
      await ensureCollection(db, 'wallet_summary');
      await ensureIndexes(db, 'wallet_summary', [{ key: { total_deod_volume: -1 }, name: 'volume' }, { key: { transaction_count: -1 }, name: 'tx_count' }]);
    },
  },
  {
    name: '002_alerts',
    async up(db) {
      await ensureCollection(db, 'alert_rules', schema(['_id', 'code', 'kind', 'name', 'enabled', 'severity', 'params'], {
        kind: { enum: ['large_transfer', 'large_swap', 'flow_spike', 'watched_wallet'] }, enabled: bool, severity: { enum: ['low', 'medium', 'high'] },
      }));
      await ensureCollection(db, 'watched_wallets', schema(['_id', 'address', 'watch', 'min_amount', 'enabled'], {
        address: addr, watch: { enum: ['both', 'incoming', 'outgoing'] }, min_amount: dec, enabled: bool,
      }));
      await ensureCollection(db, 'alerts', schema(['_id', 'dedup_key', 'rule_code', 'severity', 'source', 'occurred_at', 'amount'], {
        dedup_key: str, rule_code: str, severity: { enum: ['low', 'medium', 'high'] }, source: { enum: ['exchange_flow', 'swap', 'daily_flow'] },
        occurred_at: date, amount: dec, usd_value: decOrNull,
      }));
      await ensureIndexes(db, 'alerts', [
        { key: { dedup_key: 1 }, unique: true, name: 'dedup_unique' },
        { key: { occurred_at: -1, _id: -1 }, name: 'time' }, { key: { rule_code: 1, occurred_at: -1 }, name: 'rule_time' },
        { key: { wallet_address: 1, occurred_at: -1 }, name: 'wallet_time' }, { key: { created_at: 1 }, name: 'created' },
      ]);
      await ensureCollection(db, 'alert_state');                      // how far the scanner has read (_id = cursor name)
    },
  },
  {
    name: '003_notifications_and_telegram',
    async up(db) {
      await ensureCollection(db, 'notification_log');
      await ensureIndexes(db, 'notification_log', [
        { key: { alert_id: 1, channel: 1, recipient: 1 }, unique: true, name: 'delivery_unique' },
        { key: { channel: 1, status: 1 }, name: 'channel_status' },
      ]);
      await ensureCollection(db, 'telegram_users', schema(['_id', 'chat_id', 'status', 'failed_attempts'], {
        status: { enum: ['new', 'authorized', 'subscribed', 'blocked'] }, failed_attempts: num,
      }));
      await ensureIndexes(db, 'telegram_users', [{ key: { status: 1 }, name: 'status' }]);
    },
  },
  {
    name: '004_ask_usage',
    async up(db) {
      await ensureCollection(db, 'ask_usage');                        // daily counters only (_id = UTC day "YYYY-MM-DD"); questions and answers are not stored
    },
  },
];

/** Applies pending steps in order. Returns the names applied now. */
export async function migrate(db: Db): Promise<string[]> {
  const log = db.collection<{ _id: string; applied_at: Date }>('schema_migrations');
  const applied = new Set((await log.find().toArray()).map((r) => r._id));
  const done: string[] = [];
  for (const step of STEPS) {
    if (applied.has(step.name)) continue;
    try {
      await step.up(db);
      try { await log.insertOne({ _id: step.name, applied_at: new Date() }); } catch (e) { if (!isDuplicateKey(e)) throw e; }
      done.push(step.name);
    } catch (e) {
      throw new Error(`migration ${step.name} failed: ${(e as Error).message}`);
    }
  }
  return done;
}
