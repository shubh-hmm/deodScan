// One-off copy of the whole PostgreSQL database into MongoDB, followed by a check that nothing was lost or changed.
//
//   npm run db:copy-from-postgres -- --dry-run          read PostgreSQL, write nothing, print what would be copied
//   npm run db:copy-from-postgres                       copy into an EMPTY MongoDB database, then verify
//   npm run db:copy-from-postgres -- --replace          empty the copied collections first (re-run safely)
//   npm run db:copy-from-postgres -- --verify-only      only compare the two databases
//
// PostgreSQL is only READ (SELECT). It comes from DATABASE_URL, MongoDB from MONGODB_URI (both in backend/.env). Row ids are kept, so alert
// cursors, run histories and "newest first" orders mean exactly what they meant before. Exact amounts are carried as text, never as floats.
import pg from 'pg';
import { Decimal } from 'decimal.js';
import type { Db, Document } from 'mongodb';
import { loadEnv } from '@deod/config';
import { closeDb, decStr, getDb, migrate, raiseSequence, refreshWalletSummary, seedFromConfig, toDec128, toDec128OrNull } from '@deod/db';

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run'), REPLACE = args.has('--replace'), VERIFY_ONLY = args.has('--verify-only');
const BATCH = 2000;

const env = loadEnv();
if (!env.DATABASE_URL) throw new Error('DATABASE_URL (the PostgreSQL database to copy FROM) is not set in backend/.env');
const pgc = new pg.Client({ connectionString: env.DATABASE_URL });
await pgc.connect();
const mongo = getDb();

const num = (v: unknown) => { if (v === null || v === undefined) return null; const n = Number(v); if (!Number.isSafeInteger(n)) throw new Error(`integer out of range: ${String(v)}`); return n; };
const dec = (v: unknown) => (v === null || v === undefined ? null : toDec128(String(v)));
const decReq = (v: unknown) => toDec128(String(v));

interface Table {
  name: string;
  /** SQL that returns the columns the mapper needs; numeric / bigint columns are cast to text so nothing passes through a float. */
  select: string;
  orderBy: string;
  /** Column used for keyset paging and (if `idKey` is not given) as the new _id. */
  key: string;
  map(r: Record<string, any>): Document;
  /** Name of the sequence to raise to the highest copied id (tables that had a bigserial id). */
  sequence?: boolean;
}

const TABLES: Table[] = [
  { name: 'exchanges', key: 'slug', orderBy: 'slug', select: 'SELECT slug, name, created_at, updated_at FROM exchanges',
    map: (r) => ({ _id: r.slug, slug: r.slug, name: r.name, created_at: r.created_at, updated_at: r.updated_at }) },
  { name: 'exchange_addresses', key: 'id', orderBy: 'id', sequence: true,
    select: 'SELECT id::text, exchange, chain, address, label, address_type, source, verified, monitored, dune_label, notes, created_at, updated_at FROM exchange_addresses',
    map: (r) => ({ _id: num(r.id), exchange: r.exchange, chain: r.chain, address: r.address, label: r.label, address_type: r.address_type, source: r.source, verified: r.verified, monitored: r.monitored, dune_label: r.dune_label, notes: r.notes, created_at: r.created_at, updated_at: r.updated_at }) },
  { name: 'dex_pools', key: 'address', orderBy: 'address',
    select: 'SELECT address, chain, dex, version, pair, deod_address, quote_address, quote_symbol, quote_decimals, fee_tier, verification, updated_at FROM dex_pools',
    map: (r) => ({ _id: r.address, ...r }) },
  { name: 'token_transfers', key: 'id', orderBy: 'id', sequence: true,
    select: `SELECT id::text, chain, token_address, tx_hash, evt_index, block_number::text, block_time, from_address, to_address, amount_raw::text, amount::text, tx_from, source, ingested_at FROM token_transfers`,
    map: (r) => ({ _id: num(r.id), chain: r.chain, token_address: r.token_address, tx_hash: r.tx_hash, evt_index: r.evt_index, block_number: num(r.block_number), block_time: r.block_time, from_address: r.from_address, to_address: r.to_address, amount_raw: r.amount_raw, amount: decReq(r.amount), tx_from: r.tx_from, source: r.source, ingested_at: r.ingested_at }) },
  { name: 'exchange_flows', key: 'id', orderBy: 'id', sequence: true,
    select: `SELECT id::text, chain, exchange, direction, token_address, wallet_address, exchange_address, amount_raw::text, amount::text, tx_hash, evt_index, block_number::text, block_time FROM exchange_flows`,
    map: (r) => ({ _id: num(r.id), chain: r.chain, exchange: r.exchange, direction: r.direction, token_address: r.token_address, wallet_address: r.wallet_address, exchange_address: r.exchange_address, amount_raw: r.amount_raw, amount: decReq(r.amount), tx_hash: r.tx_hash, evt_index: r.evt_index, block_number: num(r.block_number), block_time: r.block_time }) },
  { name: 'dex_swaps', key: 'id', orderBy: 'id', sequence: true,
    select: `SELECT id::text, chain, dex, version, pool_address, tx_hash, evt_index, block_number::text, block_time, trader_address, recipient_address, tx_to, side, token_in, amount_in_raw::text,
                    token_out, amount_out_raw::text, deod_amount_raw::text, deod_amount::text, quote_token, quote_amount_raw::text, quote_amount::text, price::text, usd_value::text, usd_basis, source, ingested_at FROM dex_swaps`,
    map: (r) => ({ _id: num(r.id), chain: r.chain, dex: r.dex, version: r.version, pool_address: r.pool_address, tx_hash: r.tx_hash, evt_index: r.evt_index, block_number: num(r.block_number), block_time: r.block_time, trader_address: r.trader_address, recipient_address: r.recipient_address, tx_to: r.tx_to, side: r.side, token_in: r.token_in, amount_in_raw: r.amount_in_raw, token_out: r.token_out, amount_out_raw: r.amount_out_raw, deod_amount_raw: r.deod_amount_raw, deod_amount: decReq(r.deod_amount), quote_token: r.quote_token, quote_amount_raw: r.quote_amount_raw, quote_amount: decReq(r.quote_amount), price: decReq(r.price), usd_value: dec(r.usd_value), usd_basis: r.usd_basis, source: r.source, ingested_at: r.ingested_at }) },
  { name: 'dune_sync_state', key: 'query_name', orderBy: 'query_name',
    select: 'SELECT query_name, status, last_successful_execution, last_block_time, synced_until, last_sync_at, credits_total::text, error, updated_at, backfill_from, backfill_cursor FROM dune_sync_state',
    map: (r) => ({ _id: r.query_name, ...r, credits_total: decReq(r.credits_total) }) },
  { name: 'sync_runs', key: 'id', orderBy: 'id', sequence: true,
    select: 'SELECT id::text, query_name, mode, execution_id, window_start, window_end, started_at, finished_at, status, rows_fetched, rows_inserted, rows_duplicate, rows_rejected, credits::text, error FROM sync_runs',
    map: (r) => { const { id, ...rest } = r; return { _id: num(id), ...rest, credits: dec(r.credits) }; } },
  { name: 'ingest_rejections', key: 'id', orderBy: 'id', sequence: true,
    select: 'SELECT id::text, query_name, execution_id, reasons, raw, created_at FROM ingest_rejections',
    map: (r) => { const { id, ...rest } = r; return { _id: num(id), ...rest }; } },
  { name: 'alert_rules', key: 'code', orderBy: 'code', select: 'SELECT code, kind, name, enabled, severity, params, updated_at FROM alert_rules', map: (r) => ({ _id: r.code, ...r }) },
  { name: 'watched_wallets', key: 'address', orderBy: 'address', select: 'SELECT address, label, watch, min_amount::text, enabled, created_at FROM watched_wallets',
    map: (r) => ({ _id: r.address, ...r, min_amount: decReq(r.min_amount) }) },
  { name: 'alerts', key: 'id', orderBy: 'id', sequence: true,
    select: `SELECT id::text, dedup_key, rule_code, severity, source, occurred_at, exchange, direction, amount::text, usd_value::text, sender, recipient, wallet_address, tx_hash, evt_index, block_number::text, details, created_at FROM alerts`,
    map: (r) => { const { id, ...rest } = r; return { _id: num(id), ...rest, amount: decReq(r.amount), usd_value: dec(r.usd_value), block_number: num(r.block_number) }; } },
  { name: 'alert_state', key: 'name', orderBy: 'name', select: 'SELECT name, last_id::text, updated_at FROM alert_state', map: (r) => ({ _id: r.name, ...r, last_id: num(r.last_id) }) },
  { name: 'notification_log', key: 'id', orderBy: 'id', sequence: true,
    select: 'SELECT id::text, alert_id::text, channel, status, attempts, error, last_attempt_at, sent_at, recipient FROM notification_log',
    map: (r) => { const { id, ...rest } = r; return { _id: num(id), ...rest, alert_id: num(r.alert_id) }; } },
  { name: 'telegram_users', key: 'chat_id', orderBy: 'chat_id',
    select: 'SELECT chat_id::text, username, first_name, status, failed_attempts, locked_until, authorized_at, subscribed_at, created_at, updated_at FROM telegram_users',
    map: (r) => ({ _id: num(r.chat_id), ...r, chat_id: num(r.chat_id) }) },
  { name: 'ask_usage', key: 'day', orderBy: 'day', select: 'SELECT day::text, requests, input_tokens::text, output_tokens::text, unverified, failed FROM ask_usage',
    map: (r) => ({ _id: r.day, ...r, input_tokens: num(r.input_tokens), output_tokens: num(r.output_tokens) }) },
];

const tableExists = async (name: string) => (await pgc.query('SELECT to_regclass($1) AS t', [`public.${name}`])).rows[0].t !== null;

async function copyTable(t: Table): Promise<number> {
  const col = mongo.collection(t.name);
  let copied = 0;
  let last: unknown = null;
  // Keyset paging on the table's key: every batch is "rows after the last one seen", so memory stays small and no row is skipped or repeated.
  // Columns are qualified with the table name: a bare "id" in ORDER BY would mean the text output column (id::text) and sort 10 before 9.
  const q = (c: string) => `${t.name}.${c}`;
  const cast = t.key === 'id' || t.key === 'chat_id' ? '::bigint' : '';
  for (;;) {
    const sql = `${t.select} ${last === null ? '' : `WHERE ${q(t.key)}${cast} > $1${cast}`} ORDER BY ${q(t.orderBy)} LIMIT ${BATCH}`;
    const { rows } = await pgc.query(sql, last === null ? [] : [last]);
    if (!rows.length) break;
    const docs = rows.map((r) => t.map(r));                   // also in a dry run: a value that cannot be converted exactly stops the copy here
    if (!DRY) await col.insertMany(docs, { ordered: true });
    copied += rows.length;
    last = rows[rows.length - 1][t.key];
    if (copied % 20000 === 0) console.log(`    ${t.name}: ${copied} rows ...`);
  }
  if (!DRY && t.sequence && copied) {
    const top = await col.find({}, { projection: { _id: 1 } }).sort({ _id: -1 }).limit(1).next();
    await raiseSequence(mongo, t.name, top!._id as unknown as number);
  }
  return copied;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------------------------------------------------------------

let failures = 0;
const checks: [string, boolean, string][] = [];
const check = (label: string, ok: boolean, detail = '') => { checks.push([label, ok, detail]); if (!ok) failures++; };

const pgOne = async (sql: string) => (await pgc.query(sql)).rows[0];
const sumRaw = async (collection: string, field: string) => {
  let total = 0n;
  for await (const d of mongo.collection(collection).find({}, { projection: { [field]: 1 } })) total += BigInt(d[field] as string);
  return total.toString();
};
const mongoSum = async (collection: string, field: string, match: Document = {}) => {
  const r = await mongo.collection(collection).aggregate([{ $match: match }, { $group: { _id: null, s: { $sum: `$${field}` } } }]).toArray();
  return new Decimal(r[0] ? decStr(r[0].s) : '0');
};
const same = (a: Decimal, b: string | null) => a.equals(new Decimal(b ?? '0'));

async function verify() {
  console.log('\nVerifying (PostgreSQL vs MongoDB) ...');
  for (const t of TABLES) {
    if (!(await tableExists(t.name))) continue;
    const p = Number((await pgOne(`SELECT count(*) AS n FROM ${t.name}`)).n);
    const m = await mongo.collection(t.name).countDocuments();
    check(`${t.name}: row count`, p === m, `PostgreSQL ${p}, MongoDB ${m}`);
  }

  for (const [coll, amountFields, rawField] of [
    ['token_transfers', ['amount'], 'amount_raw'], ['exchange_flows', ['amount'], 'amount_raw'], ['dex_swaps', ['deod_amount', 'quote_amount', 'usd_value', 'price'], 'deod_amount_raw'],
  ] as const) {
    for (const f of amountFields) {
      const p = (await pgOne(`SELECT coalesce(sum(${f}), 0)::text AS s FROM ${coll}`)).s as string;
      const m = await mongoSum(coll, f);
      check(`${coll}.${f}: exact total`, same(m, p), `PostgreSQL ${p}, MongoDB ${m.toFixed()}`);
    }
    const pr = (await pgOne(`SELECT coalesce(sum(${rawField}), 0)::text AS s FROM ${coll}`)).s as string;
    const mr = await sumRaw(coll, rawField);
    check(`${coll}.${rawField}: exact total of the on-chain integers`, pr === mr, `PostgreSQL ${pr}, MongoDB ${mr}`);
    const pt = await pgOne(`SELECT min(block_time) AS a, max(block_time) AS b, count(DISTINCT tx_hash) AS d FROM ${coll}`);
    const mt = await mongo.collection(coll).aggregate([{ $group: { _id: null, a: { $min: '$block_time' }, b: { $max: '$block_time' }, d: { $addToSet: '$tx_hash' } } }]).toArray();
    check(`${coll}: first / last time and distinct transactions`, (pt.a?.getTime() ?? null) === (mt[0]?.a?.getTime() ?? null) && (pt.b?.getTime() ?? null) === (mt[0]?.b?.getTime() ?? null) && Number(pt.d) === (mt[0]?.d.length ?? 0),
      `PostgreSQL ${pt.a?.toISOString()} .. ${pt.b?.toISOString()} / ${pt.d} tx`);
  }

  for (const dir of ['IN', 'OUT']) {
    const rows = (await pgc.query(`SELECT exchange, sum(amount)::text AS s, count(*) AS n FROM exchange_flows WHERE direction = $1 GROUP BY exchange`, [dir])).rows;
    for (const r of rows) {
      const m = await mongoSum('exchange_flows', 'amount', { exchange: r.exchange, direction: dir });
      const n = await mongo.collection('exchange_flows').countDocuments({ exchange: r.exchange, direction: dir });
      check(`exchange_flows ${r.exchange} ${dir}: total and count`, same(m, r.s) && n === Number(r.n), `${r.n} rows, ${r.s}`);
    }
  }
  const sides = (await pgc.query(`SELECT version, side, sum(deod_amount)::text AS s, count(*) AS n FROM dex_swaps GROUP BY 1, 2`)).rows;
  for (const r of sides) {
    const m = await mongoSum('dex_swaps', 'deod_amount', { version: r.version, side: r.side });
    const n = await mongo.collection('dex_swaps').countDocuments({ version: r.version, side: r.side });
    check(`dex_swaps V${r.version} ${r.side}: total and count`, same(m, r.s) && n === Number(r.n), `${r.n} swaps, ${r.s}`);
  }

  // Every single row of the three big tables, compared field by field on the exact text of its amounts.
  for (const [coll, cols] of [
    ['token_transfers', ['amount_raw', 'amount::text']], ['exchange_flows', ['amount_raw', 'amount::text']], ['dex_swaps', ['deod_amount_raw', 'deod_amount::text', 'quote_amount::text', 'price::text', 'coalesce(usd_value::text, \'\')']],
  ] as const) {
    let last = 0, bad = 0, seen = 0;
    for (;;) {
      const { rows } = await pgc.query(`SELECT id::bigint AS id, tx_hash, evt_index, block_time, ${cols.map((c, i) => `${c} AS c${i}`).join(', ')} FROM ${coll} WHERE id > $1 ORDER BY id LIMIT 5000`, [last]);
      if (!rows.length) break;
      const docs = new Map((await mongo.collection(coll).find({ _id: { $in: rows.map((r) => Number(r.id)) } as never }).toArray()).map((d) => [d._id as unknown as number, d]));
      for (const r of rows) {
        const d = docs.get(Number(r.id));
        const names = coll === 'dex_swaps' ? ['deod_amount_raw', 'deod_amount', 'quote_amount', 'price', 'usd_value'] : ['amount_raw', 'amount'];
        const ok = !!d && d.tx_hash === r.tx_hash && d.evt_index === r.evt_index && d.block_time.getTime() === r.block_time.getTime() && names.every((n, i) => {
          const mine = d[n];
          if (n.endsWith('_raw')) return mine === r[`c${i}`];
          if (n === 'usd_value') return (mine == null ? '' : new Decimal(decStr(mine)).toFixed()) === (r[`c${i}`] === '' ? '' : new Decimal(r[`c${i}`]).toFixed());
          return new Decimal(decStr(mine, 30)).equals(new Decimal(r[`c${i}`]));
        });
        if (!ok) { bad++; if (bad <= 3) console.log(`    MISMATCH in ${coll} id ${r.id}`); }
        seen++;
      }
      last = Number(rows[rows.length - 1].id);
    }
    check(`${coll}: every row identical (hash, time and each exact amount)`, bad === 0 && seen > 0 || seen === 0, `${seen} rows compared, ${bad} different`);
  }

  // The summary that used to be a materialized view: rebuilt in MongoDB, compared with PostgreSQL's wallet by wallet.
  if (await tableExists('wallet_summary')) {
    const { rows } = await pgc.query(`SELECT address, first_seen, last_seen, transaction_count::text, total_deod_volume::text, sent_to_exchanges::text, received_from_exchanges::text, exchange_transfer_count::text,
                                             swap_buy_deod::text, swap_sell_deod::text, swap_count::text, swap_usd_volume::text, largest_transfer::text, largest_swap::text FROM wallet_summary`);
    const mine = new Map((await mongo.collection('wallet_summary').find().toArray()).map((d) => [d._id as unknown as string, d]));
    let bad = 0;
    const eq = (a: unknown, b: string | null) => (a == null || b == null ? a == null && b == null : new Decimal(decStr(a)).equals(new Decimal(b)));
    for (const r of rows) {
      const d = mine.get(r.address);
      const ok = !!d && d.first_seen.getTime() === r.first_seen.getTime() && d.last_seen.getTime() === r.last_seen.getTime() && d.transaction_count === Number(r.transaction_count)
        && d.exchange_transfer_count === Number(r.exchange_transfer_count) && d.swap_count === Number(r.swap_count)
        && eq(d.total_deod_volume, r.total_deod_volume) && eq(d.sent_to_exchanges, r.sent_to_exchanges) && eq(d.received_from_exchanges, r.received_from_exchanges)
        && eq(d.swap_buy_deod, r.swap_buy_deod) && eq(d.swap_sell_deod, r.swap_sell_deod) && eq(d.swap_usd_volume, r.swap_usd_volume) && eq(d.largest_transfer, r.largest_transfer) && eq(d.largest_swap, r.largest_swap);
      if (!ok) { bad++; if (bad <= 3) console.log(`    MISMATCH in wallet_summary for ${r.address}`); }
    }
    check('wallet_summary: every wallet identical to the PostgreSQL view', bad === 0 && rows.length === mine.size, `${rows.length} PostgreSQL wallets, ${mine.size} MongoDB wallets, ${bad} different`);
  }

  // Small tables: whole content.
  const small = async (name: string, sql: string, key: (r: any) => string, fields: (r: any) => unknown[]) => {
    if (!(await tableExists(name))) return;
    const rows = (await pgc.query(sql)).rows;
    const docs = await mongo.collection(name).find().toArray();
    const byKey = new Map(docs.map((d) => [String(d._id), d]));
    const bad = rows.filter((r) => { const d = byKey.get(key(r)); return !d || JSON.stringify(fields(d)) !== JSON.stringify(fields(r)); }).length;
    check(`${name}: content`, bad === 0 && rows.length === docs.length, `${rows.length} rows, ${bad} different`);
  };
  await small('exchanges', 'SELECT slug, name FROM exchanges', (r) => r.slug, (r) => [r.slug, r.name]);
  await small('exchange_addresses', 'SELECT id::text, exchange, address, address_type, source, verified, monitored FROM exchange_addresses', (r) => r.id, (r) => [r.exchange, r.address, r.address_type, r.source, r.verified, r.monitored]);
  await small('dune_sync_state', 'SELECT query_name, status, synced_until, credits_total::text FROM dune_sync_state', (r) => r.query_name, (r) => [r.query_name, r.status, r.synced_until?.toISOString?.() ?? null, new Decimal(String(r.credits_total?.toString?.() ?? r.credits_total ?? 0)).toFixed()]);
  await small('alerts', 'SELECT id::text, dedup_key, rule_code, amount::text AS amount, tx_hash FROM alerts', (r) => r.id, (r) => [r.dedup_key, r.rule_code, new Decimal(decStr(r.amount)).toFixed(), r.tx_hash]);
  await small('telegram_users', 'SELECT chat_id::text, status FROM telegram_users', (r) => r.chat_id, (r) => [String(r.chat_id ?? r._id), r.status]);
  await small('watched_wallets', 'SELECT address, watch, enabled FROM watched_wallets', (r) => r.address, (r) => [r.address ?? r._id, r.watch, r.enabled]);

  console.log('');
  for (const [label, ok, detail] of checks) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  console.log(`\n${checks.length - failures} checks passed, ${failures} failed.`);
}

// ---------------------------------------------------------------------------------------------------------------------------------

try {
  console.log(`Copy PostgreSQL ${env.DATABASE_URL.replace(/:\/\/[^@]*@/, '://***@')}  ->  MongoDB ${env.MONGODB_URI.replace(/:\/\/[^@]*@/, '://***@')}${DRY ? '   (DRY RUN: nothing is written)' : ''}`);
  if (!VERIFY_ONLY) {
    if (!DRY) {
      await migrate(mongo);
      const busy: string[] = [];
      for (const t of TABLES) if ((await mongo.collection(t.name).countDocuments({}, { limit: 1 })) > 0) busy.push(t.name);
      if (busy.length && !REPLACE) {
        throw new Error(`MongoDB already holds data (${busy.join(', ')}). Nothing was changed. Run again with --replace to empty those collections first, or point MONGODB_URI at an empty database.`);
      }
      if (REPLACE) {
        for (const t of TABLES) await mongo.collection(t.name).deleteMany({});
        await mongo.collection('counters').deleteMany({});
        console.log('Emptied the collections that are copied (--replace).');
      }
    }
    for (const t of TABLES) {
      if (!(await tableExists(t.name))) { console.log(`  ${t.name}: not in PostgreSQL, skipped`); continue; }
      const started = Date.now();
      const n = await copyTable(t);
      console.log(`  ${t.name.padEnd(20)} ${String(n).padStart(8)} rows  (${((Date.now() - started) / 1000).toFixed(1)} s)`);
    }
    if (!DRY) {
      await seedFromConfig(mongo);
      await refreshWalletSummary(mongo);
      console.log('  wallet_summary rebuilt from the copied flows and swaps');
    }
  }
  if (!DRY) await verify();
  else console.log('\nDry run finished: PostgreSQL was read successfully and every row converted without loss.');
} catch (e) {
  console.error(`\nFAILED: ${(e as Error).message}`);
  failures++;
} finally {
  await pgc.end().catch(() => {});
  await closeDb();
}
process.exit(failures ? 1 : 0);
