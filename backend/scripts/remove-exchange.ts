// Removes one exchange from the database after archiving its stored history to a CSV file.
//
//   npx tsx scripts/remove-exchange.ts <slug> [--dry-run]
//
// Steps: archive the exchange's token_transfers to backend/archive/<slug>-removed-<date>.csv, then delete its exchange_flows, token_transfers,
// exchange_addresses and exchanges documents, and rebuild the wallet summary. The archive is written first and the deletes run in an order that
// can simply be repeated, so a run that is interrupted half way is finished by running the same command again.
// It refuses to run if any of the exchange's transfers is shared with another monitored exchange, because deleting
// those rows would change the other exchange's totals.
// Also remove the exchange from config/deod.yaml, or the next startup will seed it again.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { backendRoot } from '@deod/config';
import { closeDb, getDb, plainStr, refreshWalletSummary } from '@deod/db';

const slug = process.argv[2];
const dry = process.argv.includes('--dry-run');
if (!slug || slug.startsWith('--') || !/^[a-z0-9_]+$/.test(slug)) {
  console.error('usage: npx tsx scripts/remove-exchange.ts <slug> [--dry-run]');
  process.exit(2);
}

const csvCell = (v: unknown) => {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const db = getDb();
try {
  const addrs = await db.collection('exchange_addresses').find({ exchange: slug }).toArray();
  if (!addrs.length) throw new Error(`no exchange_addresses rows for "${slug}"; nothing to remove`);
  const mine = addrs.map((a) => a.address as string);
  const theirs = (await db.collection('exchange_addresses').find({ exchange: { $ne: slug } }).toArray()).map((a) => a.address as string);

  const transfers = db.collection('token_transfers'), flows = db.collection('exchange_flows');
  const touchesMine = { $or: [{ from_address: { $in: mine } }, { to_address: { $in: mine } }] };
  const touching = await transfers.countDocuments(touchesMine);
  const shared = await transfers.countDocuments({ $or: [{ from_address: { $in: mine }, to_address: { $in: theirs } }, { to_address: { $in: mine }, from_address: { $in: theirs } }] });
  const flowCount = await flows.countDocuments({ exchange: slug });
  // Wallets that only ever touched this exchange: they disappear from the wallet summary with it.
  const mineWallets = new Set(await flows.distinct('wallet_address', { exchange: slug }));
  const elsewhere = new Set([...(await flows.distinct('wallet_address', { exchange: { $ne: slug } })), ...(await db.collection('dex_swaps').distinct('trader_address'))]);
  const soleWallets = [...mineWallets].filter((w) => !elsewhere.has(w)).length;

  console.log(`exchange "${slug}": ${mine.length} address(es), ${touching} transfers, ${flowCount} flow rows, ${soleWallets} wallets seen only through it`);
  console.log(`transfers shared with other monitored exchanges: ${shared}`);
  if (shared > 0) throw new Error('refusing: shared transfers would change another exchange\'s totals');
  if (dry) { console.log('dry run: nothing changed'); process.exit(0); }

  // 1. archive
  const rows = await transfers.find(touchesMine).sort({ block_number: 1, evt_index: 1 }).toArray();
  const cols = ['chain', 'token_address', 'tx_hash', 'evt_index', 'block_number', 'block_time', 'from_address', 'to_address', 'amount_raw', 'amount', 'tx_from', 'source', 'ingested_at'];
  const archive = resolve(backendRoot(), 'archive');
  mkdirSync(archive, { recursive: true });
  const file = resolve(archive, `${slug}-removed-${new Date().toISOString().slice(0, 10)}.csv`);
  writeFileSync(file, [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(c === 'amount' ? plainStr(r[c]) : r[c])).join(','))].join('\r\n') + '\r\n');
  console.log(`archived ${rows.length} transfers -> ${file}`);

  // 2. delete (each step can be repeated if this run is interrupted)
  const del = async (label: string, n: Promise<{ deletedCount: number }>) => console.log(`deleted ${(await n).deletedCount} ${label}`);
  await del('exchange_flows', flows.deleteMany({ exchange: slug }));
  await del('token_transfers', transfers.deleteMany(touchesMine));
  await del('exchange_addresses', db.collection('exchange_addresses').deleteMany({ exchange: slug }));
  await del('exchanges', db.collection('exchanges').deleteMany({ _id: slug as never }));
  await refreshWalletSummary(db);
  console.log('rebuilt wallet_summary. Remember to remove the exchange from config/deod.yaml.');
} catch (e) {
  console.error(`ERROR: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
