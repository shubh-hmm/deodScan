// The daily budget of "Ask DEODScan AI": at most ASK_DAILY_LIMIT questions per UTC day, counted in the database so it survives restarts and
// holds across several backend copies. Only counters are kept (never the question or the answer).
import type { Db } from 'mongodb';
import { isDuplicateKey } from '@deod/db';

export interface Usage { day: string; requests: number; limit: number; remaining: number; inputTokens: number; outputTokens: number }

const today = (now: Date) => now.toISOString().slice(0, 10);
const usage = (db: Db) => db.collection('ask_usage');

/** Takes one question from today's budget. Returns false (and takes nothing) when the budget is used up. */
export async function reserveQuestion(db: Db, limit: number, now = new Date()): Promise<boolean> {
  const day = today(now);
  try {
    // The filter only matches while the day is under its limit; at the limit the upsert tries to create the day again, hits the unique _id and is refused.
    const r = await usage(db).updateOne(
      { _id: day as never, requests: { $lt: limit } },
      { $inc: { requests: 1 }, $setOnInsert: { day, input_tokens: 0, output_tokens: 0, unverified: 0, failed: 0 } },
      { upsert: true },
    );
    return r.matchedCount + r.upsertedCount > 0;
  } catch (e) {
    if (isDuplicateKey(e)) return false;
    throw e;
  }
}

/** Gives a question back (the model was never called, e.g. the input was rejected). */
export async function refundQuestion(db: Db, now = new Date()) {
  await usage(db).updateOne({ _id: today(now) as never, requests: { $gt: 0 } }, { $inc: { requests: -1 } });
}

export async function recordUsage(db: Db, u: { inputTokens?: number; outputTokens?: number; unverified?: boolean; failed?: boolean }, now = new Date()) {
  await usage(db).updateOne(
    { _id: today(now) as never },
    { $inc: { input_tokens: u.inputTokens ?? 0, output_tokens: u.outputTokens ?? 0, unverified: u.unverified ? 1 : 0, failed: u.failed ? 1 : 0 } },
  );
}

export async function usageToday(db: Db, limit: number, now = new Date()): Promise<Usage> {
  const row = await usage(db).findOne({ _id: today(now) as never });
  const requests = (row?.requests as number | undefined) ?? 0;
  return { day: today(now), requests, limit, remaining: Math.max(0, limit - requests), inputTokens: Number(row?.input_tokens ?? 0), outputTokens: Number(row?.output_tokens ?? 0) };
}
