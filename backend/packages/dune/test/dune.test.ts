import { describe, expect, it } from 'vitest';
import { DuneClient, DuneError, type DuneOptions } from '../src/index.js';

const FAST: Partial<DuneOptions> = { pollStartMs: 1, pollMaxMs: 2, retryBaseMs: 1, requestTimeoutMs: 2000, maxRetries: 2 };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fake Dune: `handler` decides the answer for each call; every call is recorded. */
function fakeDune(handler: (path: string, method: string, n: number) => Response | Promise<Response>) {
  const calls: { path: string; method: string }[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const path = url.replace('https://api.dune.com/api/v1', '');
    const method = init.method ?? 'GET';
    calls.push({ path, method });
    return handler(path, method, calls.length);
  }) as unknown as typeof fetch;
  return { f, calls, cancelled: () => calls.filter((c) => c.method === 'POST' && c.path.endsWith('/cancel')).length };
}
const client = (f: typeof fetch, opts: Partial<DuneOptions> = {}) => new DuneClient('secret-key-123', undefined, { ...FAST, ...opts }, f);

describe('a normal run', () => {
  it('waits for completion, reads every page and reports the credits used', async () => {
    let polls = 0;
    const d = fakeDune((path) => {
      if (path === '/sql/execute') return json(200, { execution_id: 'ex1' });
      if (path === '/execution/ex1/status') return json(200, { state: ++polls < 3 ? 'QUERY_STATE_EXECUTING' : 'QUERY_STATE_COMPLETED', execution_cost_credits: 0.42 });
      if (path.startsWith('/execution/ex1/results?limit=5000&offset=0')) return json(200, { result: { rows: [{ a: 1 }, { a: 2 }], metadata: { column_names: ['a'], column_types: ['integer'] } }, next_offset: 2 });
      if (path.startsWith('/execution/ex1/results?limit=5000&offset=2')) return json(200, { result: { rows: [{ a: 3 }] }, next_offset: null });
      return json(404, {});
    });
    const r = await client(d.f).runSql('select 1');
    expect(r).toMatchObject({ executionId: 'ex1', columns: ['a'], creditsUsed: 0.42 });
    expect(r.rows).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
    expect(d.cancelled()).toBe(0);
  });
});

describe('protecting the credit balance', () => {
  it('cancels a run whose cost passes the per-run limit, and says why', async () => {
    const d = fakeDune((path, method) => {
      if (path === '/sql/execute') return json(200, { execution_id: 'ex2' });
      if (path.endsWith('/cancel')) return json(200, { success: true });
      if (path.endsWith('/status')) return json(200, { state: 'QUERY_STATE_EXECUTING', execution_cost_credits: 47.9 });
      return json(404, {});
    });
    const e = await client(d.f, { maxCreditsPerRun: 30 }).runSql('select 1').catch((x) => x);
    expect(e).toBeInstanceOf(DuneError);
    expect(e.message).toMatch(/already cost 47\.9 credits, over the limit of 30/);
    expect(e.message).toMatch(/DUNE_MAX_CREDITS_PER_RUN/);
    expect(d.cancelled()).toBe(1);
  });

  it('cancels a run that takes too long', async () => {
    const d = fakeDune((path) => {
      if (path === '/sql/execute') return json(200, { execution_id: 'ex3' });
      if (path.endsWith('/cancel')) return json(200, { success: true });
      return json(200, { state: 'QUERY_STATE_EXECUTING', execution_cost_credits: 0.5 });
    });
    const e = await client(d.f, { maxRunMs: 40 }).runSql('select 1').catch((x) => x);
    expect(e.message).toMatch(/still running after/);
    expect(d.cancelled()).toBe(1);
  });

  it('lets a deliberately large run through when the limit is raised', async () => {
    let n = 0;
    const d = fakeDune((path) => {
      if (path === '/sql/execute') return json(200, { execution_id: 'ex4' });
      if (path.endsWith('/status')) return json(200, { state: ++n < 2 ? 'QUERY_STATE_EXECUTING' : 'QUERY_STATE_COMPLETED', execution_cost_credits: 47.9 });
      return json(200, { result: { rows: [] }, next_offset: null });
    });
    await expect(client(d.f, { maxCreditsPerRun: 100 }).runSql('select 1')).resolves.toMatchObject({ creditsUsed: 47.9 });
    expect(d.cancelled()).toBe(0);
  });

  it('recognises a cancelled run at once instead of waiting for the timeout (Dune spells it with two L\'s)', async () => {
    const d = fakeDune((path) => (path === '/sql/execute' ? json(200, { execution_id: 'ex5' }) : json(200, { state: 'QUERY_STATE_CANCELLED', execution_cost_credits: 71.2 })));
    const t = Date.now();
    await expect(client(d.f, { maxRunMs: 60_000 }).runSql('select 1')).rejects.toThrow(/ended in QUERY_STATE_CANCELLED/);
    expect(Date.now() - t).toBeLessThan(1000);
  });

  it('never ingests a partial result', async () => {
    const d = fakeDune((path) => (path === '/sql/execute' ? json(200, { execution_id: 'ex6' }) : json(200, { state: 'QUERY_STATE_COMPLETED_PARTIAL' })));
    await expect(client(d.f).runSql('select 1')).rejects.toThrow(/ended in QUERY_STATE_COMPLETED_PARTIAL/);
  });

  it('a failed cancel does not hide the real reason the run was stopped', async () => {
    const d = fakeDune((path) => {
      if (path === '/sql/execute') return json(200, { execution_id: 'ex7' });
      if (path.endsWith('/cancel')) return json(500, {});
      return json(200, { state: 'QUERY_STATE_EXECUTING', execution_cost_credits: 99 });
    });
    await expect(client(d.f, { maxRetries: 0 }).runSql('select 1')).rejects.toThrow(/over the limit/);
  });
});

describe('talking to Dune', () => {
  it('retries a temporary server error and then succeeds', async () => {
    let tries = 0;
    const d = fakeDune((path) => {
      if (path === '/sql/execute') return ++tries < 2 ? json(503, {}) : json(200, { execution_id: 'ex8' });
      if (path.endsWith('/status')) return json(200, { state: 'QUERY_STATE_COMPLETED' });
      return json(200, { result: { rows: [{ ok: true }] }, next_offset: null });
    });
    expect((await client(d.f).runSql('select 1')).rows).toEqual([{ ok: true }]);
    expect(tries).toBe(2);
  });

  it('gives up after the retry limit with a clear error', async () => {
    const d = fakeDune(() => json(429, {}));
    await expect(client(d.f, { maxRetries: 1 }).runSql('select 1')).rejects.toThrow(/Dune 429/);
  });

  it('turns a network failure into an error after retrying, without exposing the API key', async () => {
    const f = (async () => { throw new Error('connect ECONNREFUSED'); }) as unknown as typeof fetch;
    const e = await client(f).runSql('select 1').catch((x) => x);
    expect(e).toBeInstanceOf(DuneError);
    expect(e.message).toMatch(/network error/);
    expect(JSON.stringify(e)).not.toContain('secret-key-123');
  });

  it('refuses to start without an API key', () => {
    expect(() => new DuneClient('')).toThrow(/DUNE_API_KEY/);
  });
});
