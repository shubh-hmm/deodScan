import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { backendRoot } from '@deod/config';

const API = 'https://api.dune.com/api/v1';
// Dune spells the cancelled state with two L's; the single-L spelling is kept in case an older response uses it. A state missing from
// this list would be waited on until the run timeout.
const TERMINAL = new Set([
  'QUERY_STATE_COMPLETED', 'QUERY_STATE_FAILED', 'QUERY_STATE_CANCELLED', 'QUERY_STATE_CANCELED',
  'QUERY_STATE_EXPIRED', 'QUERY_STATE_COMPLETED_PARTIAL',
]);

export class DuneError extends Error {
  constructor(message: string, readonly status?: number, readonly body?: unknown) {
    super(message);
  }
}

export interface DuneResult {
  executionId: string;
  columns: string[];
  columnTypes: string[];
  rows: Record<string, unknown>[];
  creditsUsed: number | null;
}

interface Logger { info(o: object, m?: string): void; warn(o: object, m?: string): void }
const noop: Logger = { info() {}, warn() {} };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n > 0 ? n : fallback;
};

export interface DuneOptions {
  maxRetries: number;
  pageSize: number;
  pollStartMs: number;
  pollMaxMs: number;
  retryBaseMs: number;
  /** Longest wait for one HTTP call to Dune. */
  requestTimeoutMs: number;
  /** A run still going after this long is cancelled (Dune keeps billing a run until it ends). */
  maxRunMs: number;
  /** A run whose cost so far exceeds this many credits is cancelled. Normal daily runs cost well under 1; a 3-month history load about 10. */
  maxCreditsPerRun: number;
}

/** Limits that protect the Dune credit balance. Environment: DUNE_MAX_RUN_MINUTES (default 10), DUNE_MAX_CREDITS_PER_RUN (default 30). */
export const defaultDuneOptions = (): DuneOptions => ({
  maxRetries: 6, pageSize: 5000, pollStartMs: 1000, pollMaxMs: 15_000, retryBaseMs: 1000, requestTimeoutMs: 60_000,
  maxRunMs: num(process.env.DUNE_MAX_RUN_MINUTES, 10) * 60_000,
  maxCreditsPerRun: num(process.env.DUNE_MAX_CREDITS_PER_RUN, 30),
});

export class DuneClient {
  private readonly opts: DuneOptions;

  constructor(
    private readonly apiKey: string,
    private readonly log: Logger = noop,
    opts: Partial<DuneOptions> = {},
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!apiKey) throw new DuneError('DUNE_API_KEY is not configured');
    this.opts = { ...defaultDuneOptions(), ...opts };
  }

  private async request<T>(path: string, init: RequestInit = {}, attempt = 0): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(API + path, {
        ...init,
        signal: AbortSignal.timeout(this.opts.requestTimeoutMs),
        headers: { 'X-Dune-Api-Key': this.apiKey, 'Content-Type': 'application/json', ...init.headers },
      });
    } catch (err) {
      if (attempt >= this.opts.maxRetries) throw new DuneError(`network error on ${path}: ${(err as Error).message}`);
      await sleep(this.opts.retryBaseMs * 2 ** attempt);
      return this.request(path, init, attempt + 1);
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= this.opts.maxRetries) {
        throw new DuneError(`Dune ${res.status} on ${path} after ${attempt} retries`, res.status, await res.text());
      }
      const retryAfter = Number(res.headers.get('retry-after'));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : this.opts.retryBaseMs * 2 ** attempt;
      this.log.warn({ status: res.status, path, wait, attempt }, 'dune rate-limited/server error; backing off');
      await sleep(wait);
      return this.request(path, init, attempt + 1);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new DuneError(`Dune ${res.status} on ${path}`, res.status, body);
    return body as T;
  }

  /** Asks Dune to stop a run. Best effort: a failure here must not hide the real reason the run was abandoned. */
  private async cancel(executionId: string, reason: string) {
    try {
      await this.request(`/execution/${executionId}/cancel`, { method: 'POST' });
      this.log.warn({ executionId, reason }, 'dune execution cancelled');
    } catch (err) {
      this.log.warn({ executionId, reason, err: (err as Error).message }, 'could not cancel the dune execution; check it on dune.com');
    }
  }

  /** Executes raw SQL (POST /v1/sql/execute), waits for completion, and pages through all rows. */
  async runSql(sql: string, performance: 'medium' | 'large' = 'medium'): Promise<DuneResult> {
    const { execution_id } = await this.request<{ execution_id: string }>('/sql/execute', {
      method: 'POST',
      body: JSON.stringify({ sql, performance }),
    });
    this.log.info({ executionId: execution_id }, 'dune execution started');

    const started = Date.now();
    let delay = this.opts.pollStartMs;
    let status: { state: string; error?: unknown; execution_cost_credits?: number };
    try {
      for (;;) {
        status = await this.request(`/execution/${execution_id}/status`);
        if (TERMINAL.has(status.state)) break;
        // A running query is billed for as long as it runs: stop it when it takes too long or has already cost too much.
        const cost = status.execution_cost_credits ?? 0;
        if (cost > this.opts.maxCreditsPerRun) {
          throw new DuneError(`execution ${execution_id} was stopped: it had already cost ${cost.toFixed(1)} credits, over the limit of ${this.opts.maxCreditsPerRun} per run (raise DUNE_MAX_CREDITS_PER_RUN for a deliberately large load)`);
        }
        if (Date.now() - started > this.opts.maxRunMs) {
          throw new DuneError(`execution ${execution_id} was stopped: still running after ${Math.round(this.opts.maxRunMs / 60_000)} minutes (cost so far ${cost.toFixed(1)} credits; raise DUNE_MAX_RUN_MINUTES for a deliberately large load)`);
        }
        await sleep(delay);
        delay = Math.min(delay * 1.5, this.opts.pollMaxMs);
      }
    } catch (err) {
      await this.cancel(execution_id, err instanceof Error ? err.message : 'error while waiting');
      throw err;
    }
    // A partial result means truncated data; never ingest it silently.
    if (status.state !== 'QUERY_STATE_COMPLETED') {
      throw new DuneError(`execution ${execution_id} ended in ${status.state}`, undefined, status.error ?? status);
    }

    const rows: Record<string, unknown>[] = [];
    let columns: string[] = [];
    let columnTypes: string[] = [];
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const page: {
        result?: { rows?: Record<string, unknown>[]; metadata?: { column_names?: string[]; column_types?: string[] } };
        next_offset?: number | null;
      } = await this.request(`/execution/${execution_id}/results?limit=${this.opts.pageSize}&offset=${offset}`);
      if (offset === 0) {
        columns = page.result?.metadata?.column_names ?? [];
        columnTypes = page.result?.metadata?.column_types ?? [];
      }
      rows.push(...(page.result?.rows ?? []));
      offset = page.next_offset ?? undefined;
    }
    return { executionId: execution_id, columns, columnTypes, rows, creditsUsed: status.execution_cost_credits ?? null };
  }
}

// ---------------------------------------------------------------------------
// SQL templates (queries/dune/*.sql). Values are validated before substitution.
// ---------------------------------------------------------------------------

const ADDR = /^0x[0-9a-f]{40}$/;
const ADDR_LIST = /^0x[0-9a-f]{40}(,0x[0-9a-f]{40})*$/;
const TS = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

const VALIDATORS: Record<string, RegExp> = {
  token_address: ADDR,
  exchange_address: ADDR,
  exchange_addresses: ADDR_LIST,
  pool_addresses: ADDR_LIST,
  quote_addresses: ADDR_LIST,
  start_time: TS,
  end_time: TS,
};

export function renderSql(template: string, params: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = params[key];
    const re = VALIDATORS[key];
    if (value === undefined) throw new Error(`missing SQL param {{${key}}}`);
    if (!re) throw new Error(`no validator for SQL param {{${key}}}`);
    if (!re.test(value)) throw new Error(`invalid value for {{${key}}}: ${value}`);
    return value;
  });
}

export function loadQuery(name: string): string {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`invalid query name ${name}`);
  return readFileSync(resolve(backendRoot(), 'queries/dune', `${name}.sql`), 'utf8');
}

/** Date -> 'YYYY-MM-DD HH:MM:SS' (UTC) as expected by the SQL templates. */
export function duneTimestamp(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}
