#!/usr/bin/env node
// Removes one exchange from the database after archiving its stored history to a CSV file.
//
//   node scripts/remove-exchange.mjs <slug> [--dry-run]
//
// Steps (one transaction): archive the exchange's token_transfers to archive/<slug>-<date>.csv, then delete its
// exchange_flows, token_transfers, exchange_addresses and exchanges rows, and refresh the wallet summary.
// It refuses to run if any of the exchange's transfers is shared with another monitored exchange, because deleting
// those rows would change the other exchange's totals.
// Also remove the exchange from config/deod.yaml, or the next startup will seed it again.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const slug = process.argv[2];
const dry = process.argv.includes('--dry-run');
if (!slug || slug.startsWith('--') || !/^[a-z0-9_]+$/.test(slug)) {
  console.error('usage: node scripts/remove-exchange.mjs <slug> [--dry-run]');
  process.exit(2);
}

function loadEnv() {
  const p = resolve(ROOT, '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv();
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');

const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
try {
  const { rows: addrs } = await db.query('SELECT address FROM exchange_addresses WHERE exchange = $1', [slug]);
  if (!addrs.length) throw new Error(`no exchange_addresses rows for "${slug}"; nothing to remove`);
  const mine = addrs.map((a) => a.address);
  const { rows: others } = await db.query('SELECT address FROM exchange_addresses WHERE exchange <> $1', [slug]);
  const theirs = others.map((a) => a.address);

  const count = async (sql, p) => (await db.query(sql, p)).rows[0].n;
  const touching = await count('SELECT count(*)::int n FROM token_transfers WHERE from_address = ANY($1) OR to_address = ANY($1)', [mine]);
  const shared = await count(
    `SELECT count(*)::int n FROM token_transfers
     WHERE (from_address = ANY($1) AND to_address = ANY($2)) OR (to_address = ANY($1) AND from_address = ANY($2))`, [mine, theirs]);
  const flows = await count('SELECT count(*)::int n FROM exchange_flows WHERE exchange = $1', [slug]);
  const soleWallets = await count(
    `SELECT count(*)::int n FROM wallet_summary w
     WHERE EXISTS (SELECT 1 FROM exchange_flows f WHERE f.wallet_address = w.address AND f.exchange = $1)
       AND NOT EXISTS (SELECT 1 FROM exchange_flows f WHERE f.wallet_address = w.address AND f.exchange <> $1)
       AND NOT EXISTS (SELECT 1 FROM dex_swaps s WHERE s.trader_address = w.address)`, [slug]);

  console.log(`exchange "${slug}": ${mine.length} address(es), ${touching} transfers, ${flows} flow rows, ${soleWallets} wallets seen only through it`);
  console.log(`transfers shared with other monitored exchanges: ${shared}`);
  if (shared > 0) throw new Error('refusing: shared transfers would change another exchange\'s totals');
  if (dry) { console.log('dry run: nothing changed'); process.exit(0); }

  // 1. archive
  const { rows } = await db.query(
    `SELECT chain, token_address, tx_hash, evt_index, block_number, block_time, from_address, to_address,
            amount_raw::text, amount::text, tx_from, source, ingested_at
     FROM token_transfers WHERE from_address = ANY($1) OR to_address = ANY($1) ORDER BY block_number, evt_index`, [mine]);
  const cols = Object.keys(rows[0] ?? { chain: 1 });
  mkdirSync(resolve(ROOT, 'archive'), { recursive: true });
  const file = resolve(ROOT, 'archive', `${slug}-removed-${new Date().toISOString().slice(0, 10)}.csv`);
  writeFileSync(file, [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n') + '\r\n');
  console.log(`archived ${rows.length} transfers -> ${file}`);

  // 2. delete, atomically
  await db.query('BEGIN');
  const del = async (label, sql, p) => { const r = await db.query(sql, p); console.log(`deleted ${r.rowCount} ${label}`); };
  await del('exchange_flows', 'DELETE FROM exchange_flows WHERE exchange = $1', [slug]);
  await del('token_transfers', 'DELETE FROM token_transfers WHERE from_address = ANY($1) OR to_address = ANY($1)', [mine]);
  await del('exchange_addresses', 'DELETE FROM exchange_addresses WHERE exchange = $1', [slug]);
  await del('exchanges', 'DELETE FROM exchanges WHERE slug = $1', [slug]);
  await db.query('COMMIT');
  await db.query('REFRESH MATERIALIZED VIEW wallet_summary');
  console.log('refreshed wallet_summary. Remember to remove the exchange from config/deod.yaml.');
} catch (e) {
  await db.query('ROLLBACK').catch(() => {});
  console.error(`ERROR: ${e.message}`);
  process.exitCode = 1;
} finally {
  await db.end();
}
