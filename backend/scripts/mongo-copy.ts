// Copies ALL data from the database in MONGODB_URI (your local one) into another MongoDB (the live one), then proves the copy is identical.
//
//   npm run db:copy-to -- "<target connection string>" --dry-run     count what would be copied, write nothing
//   npm run db:copy-to -- "<target connection string>"                copy into an EMPTY target database, then verify
//   npm run db:copy-to -- "<target connection string>" --replace      empty the target's copied collections first (repeat the copy later)
//   npm run db:copy-to -- "<target connection string>" --verify-only  only compare
//
// The source is only read. Documents are copied exactly (same ids, exact Decimal128 amounts, dates), so the live site starts with every
// transfer, swap, alert, sync checkpoint and Telegram subscriber you have now. The target gets its collections, validation rules and
// indexes from the same migrate() the app uses. The sync lock is not copied. Verification hashes every document on both sides.
import { createHash } from 'node:crypto';
import { EJSON } from 'bson';
import { MongoClient, type Db, type Document } from 'mongodb';
import { loadEnv } from '@deod/config';
import { databaseName, migrate } from '@deod/db';

const argv = process.argv.slice(2);
const targetUri = argv.find((a) => !a.startsWith('--'));
const DRY = argv.includes('--dry-run'), REPLACE = argv.includes('--replace'), VERIFY_ONLY = argv.includes('--verify-only');
if (!targetUri || !/^mongodb(\+srv)?:\/\//.test(targetUri)) {
  console.error('usage: npm run db:copy-to -- "mongodb+srv://user:password@host/deod_monitor" [--dry-run | --replace | --verify-only]');
  process.exit(2);
}
const mask = (u: string) => u.replace(/:\/\/[^@/]*@/, '://***@');
const sourceUri = loadEnv().MONGODB_URI;
if (databaseName(sourceUri) === databaseName(targetUri) && sourceUri.replace(/\/[^/]*$/, '') === targetUri.replace(/\/[^/]*$/, '')) {
  console.error('The target is the same database as the source (MONGODB_URI). Nothing to do.');
  process.exit(2);
}

const SKIP = new Set(['locks']);
const BATCH = 2000;
let failures = 0;

async function digest(db: Db, name: string): Promise<{ n: number; hash: string }> {
  const h = createHash('sha256');
  let n = 0;
  for await (const d of db.collection(name).find().sort({ _id: 1 })) { h.update(EJSON.stringify(d, { relaxed: false })); n++; }
  return { n, hash: h.digest('hex') };
}

const src = new MongoClient(sourceUri, { serverSelectionTimeoutMS: 10_000 });
const dst = new MongoClient(targetUri, { serverSelectionTimeoutMS: 15_000 });
try {
  await src.connect();
  await dst.connect();
  const from = src.db(databaseName(sourceUri)), to = dst.db(databaseName(targetUri));
  const names = (await from.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).filter((n) => !SKIP.has(n) && !n.startsWith('system.') && n !== 'schema_migrations').sort();
  console.log(`Copy MongoDB ${mask(sourceUri)} -> ${mask(targetUri)}${DRY ? '   (DRY RUN)' : ''}`);

  if (!VERIFY_ONLY) {
    if (!DRY) {
      await migrate(to);
      const busy: string[] = [];
      for (const n of names) if ((await to.collection(n).countDocuments({}, { limit: 1 })) > 0) busy.push(n);
      if (busy.length && !REPLACE) throw new Error(`The target already holds data (${busy.join(', ')}). Nothing was changed. Use --replace to empty those collections first, or a new empty database.`);
      if (REPLACE) for (const n of names) await to.collection(n).deleteMany({});
    }
    for (const n of names) {
      const total = await from.collection(n).countDocuments();
      if (!DRY) {
        let batch: Document[] = [], copied = 0;
        for await (const d of from.collection(n).find().sort({ _id: 1 })) {
          batch.push(d);
          if (batch.length >= BATCH) { await to.collection(n).insertMany(batch, { ordered: true }); copied += batch.length; batch = []; }
        }
        if (batch.length) { await to.collection(n).insertMany(batch, { ordered: true }); copied += batch.length; }
        if (copied !== total) throw new Error(`${n}: copied ${copied} of ${total}`);
      }
      console.log(`  ${n.padEnd(20)} ${String(total).padStart(8)} documents`);
    }
  }

  if (!DRY) {
    console.log('\nVerifying every document on both sides ...');
    for (const n of names) {
      const [a, b] = await Promise.all([digest(from, n), digest(to, n)]);
      const ok = a.n === b.n && a.hash === b.hash;
      if (!ok) failures++;
      console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}: ${a.n} documents here, ${b.n} there${ok ? ', identical' : ', DIFFERENT'}`);
    }
    console.log(failures ? `\n${failures} collection(s) differ. Do not go live on this copy.` : '\nThe target holds an exact copy of all data.');
  }
} catch (e) {
  console.error(`\nFAILED: ${(e as Error).message}`);
  failures++;
} finally {
  await src.close().catch(() => {});
  await dst.close().catch(() => {});
}
process.exit(failures ? 1 : 0);
