// Small MongoDB helpers shared by the whole backend: sequence numbers, duplicate-tolerant inserts and a cross-process lock.
import { randomUUID } from 'node:crypto';
import { MongoBulkWriteError, MongoServerError, type Collection, type Db, type Document, type OptionalUnlessRequiredId } from 'mongodb';

export const isDuplicateKey = (e: unknown): boolean =>
  (e instanceof MongoServerError && e.code === 11000) || (typeof e === 'object' && e !== null && (e as { code?: number }).code === 11000);

/**
 * Reserves `count` consecutive numbers from the named sequence and returns the first. Numbers only ever go up and are never reused, which is
 * what the old bigserial ids were used for (newest-first order, "everything after id N" cursors). A number that ends up unused (a duplicate row
 * that was refused) is simply skipped.
 */
export async function nextIds(db: Db, name: string, count = 1): Promise<number> {
  const doc = await db.collection<{ _id: string; seq: number }>('counters').findOneAndUpdate(
    { _id: name }, { $inc: { seq: count } }, { upsert: true, returnDocument: 'after' },
  );
  return doc!.seq - count + 1;
}

/** Makes sure the sequence is at least `value` (used after copying rows that already have ids). */
export async function raiseSequence(db: Db, name: string, value: number) {
  await db.collection<{ _id: string; seq: number }>('counters').updateOne({ _id: name }, { $max: { seq: value } }, { upsert: true });
}

/**
 * insertMany that skips rows violating a unique index (the old INSERT … ON CONFLICT DO NOTHING). Returns how many rows were really inserted.
 * Any other error is thrown.
 */
export async function insertIgnoringDuplicates<T extends Document>(col: Collection<T>, docs: OptionalUnlessRequiredId<T>[]): Promise<number> {
  if (!docs.length) return 0;
  try {
    return (await col.insertMany(docs, { ordered: false })).insertedCount;
  } catch (e) {
    if (e instanceof MongoBulkWriteError && onlyDuplicates(e)) return e.result.insertedCount;
    throw e;
  }
}

function onlyDuplicates(e: MongoBulkWriteError): boolean {
  const errs = Array.isArray(e.writeErrors) ? e.writeErrors : e.writeErrors ? [e.writeErrors] : [];
  return errs.length > 0 && errs.every((w) => w.code === 11000);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Lock (replaces the PostgreSQL advisory lock)
// ---------------------------------------------------------------------------------------------------------------------------------

interface LockDoc { _id: string; owner: string; expires_at: Date; acquired_at: Date }

/**
 * Runs `fn` while holding the named cluster-wide lock, or throws `busy()` when another process holds it. The lock is a lease that this process
 * renews every third of the lease while `fn` runs, so a crashed process cannot block everyone for longer than the lease (2 minutes).
 */
export async function withLock<T>(db: Db, name: string, busy: () => Error, fn: () => Promise<T>, leaseMs = 120_000): Promise<T> {
  const locks = db.collection<LockDoc>('locks');
  const owner = `${process.pid}-${randomUUID()}`;
  const now = new Date();
  let got = false;
  try {
    const doc = await locks.findOneAndUpdate(
      { _id: name, expires_at: { $lt: now } },
      { $set: { owner, acquired_at: now, expires_at: new Date(now.getTime() + leaseMs) } },
      { upsert: true, returnDocument: 'after' },
    );
    got = doc?.owner === owner;
  } catch (e) {
    if (!isDuplicateKey(e)) throw e;                       // the lock exists and has not expired: somebody else is holding it
  }
  if (!got) throw busy();
  const beat = setInterval(() => {
    void locks.updateOne({ _id: name, owner }, { $set: { expires_at: new Date(Date.now() + leaseMs) } }).catch(() => {});
  }, leaseMs / 3);
  beat.unref();
  try {
    return await fn();
  } finally {
    clearInterval(beat);
    await locks.deleteOne({ _id: name, owner }).catch(() => {});
  }
}
