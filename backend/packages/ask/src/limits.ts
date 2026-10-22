// The daily budget of "Ask DEODScan AI": at most ASK_DAILY_LIMIT questions per UTC day, counted in the database so it survives restarts and
// holds across several backend copies. Only counters are kept (never the question or the answer).
import type pg from 'pg';

export interface Usage { day: string; requests: number; limit: number; remaining: number; inputTokens: number; outputTokens: number }

const today = (now: Date) => now.toISOString().slice(0, 10);

/** Takes one question from today's budget. Returns false (and takes nothing) when the budget is used up. */
export async function reserveQuestion(db: pg.Pool, limit: number, now = new Date()): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO ask_usage (day, requests) VALUES ($1, 1)
     ON CONFLICT (day) DO UPDATE SET requests = ask_usage.requests + 1 WHERE ask_usage.requests < $2`,
    [today(now), limit],
  );
  return (rowCount ?? 0) > 0;
}

/** Gives a question back (the model was never called, e.g. the input was rejected). */
export async function refundQuestion(db: pg.Pool, now = new Date()) {
  await db.query(`UPDATE ask_usage SET requests = greatest(requests - 1, 0) WHERE day = $1`, [today(now)]);
}

export async function recordUsage(db: pg.Pool, u: { inputTokens?: number; outputTokens?: number; unverified?: boolean; failed?: boolean }, now = new Date()) {
  await db.query(
    `UPDATE ask_usage SET input_tokens = input_tokens + $2, output_tokens = output_tokens + $3,
            unverified = unverified + $4, failed = failed + $5 WHERE day = $1`,
    [today(now), u.inputTokens ?? 0, u.outputTokens ?? 0, u.unverified ? 1 : 0, u.failed ? 1 : 0],
  );
}

export async function usageToday(db: pg.Pool, limit: number, now = new Date()): Promise<Usage> {
  const { rows } = await db.query(`SELECT requests, input_tokens::float8 AS i, output_tokens::float8 AS o FROM ask_usage WHERE day = $1`, [today(now)]);
  const requests = rows[0]?.requests ?? 0;
  return { day: today(now), requests, limit, remaining: Math.max(0, limit - requests), inputTokens: rows[0]?.i ?? 0, outputTokens: rows[0]?.o ?? 0 };
}
