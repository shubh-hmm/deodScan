import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { repoRoot } from '@deod/config';

const API = 'https://api.dune.com/api/v1';
const TERMINAL = new Set([
  'QUERY_STATE_COMPLETED', 'QUERY_STATE_FAILED', 'QUERY_STATE_CANCELED',
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

export class DuneClient {
  constructor(
    private readonly apiKey: string,
    private readonly log: Logger = noop,
    private readonly opts = { maxRetries: 6, pageSize: 5000, pollMaxMs: 15_000, timeoutMs: 30 * 60_000 },
  ) {
    if (!apiKey) throw new DuneError('DUNE_API_KEY is not configured');
  }

  private async request<T>(path: string, init: RequestInit = {}, attempt = 0): Promise<T> {
    let res: Response;
    try {
      res = await fetch(API + path, {
        ...init,
        headers: { 'X-Dune-Api-Key': this.apiKey, 'Content-Type': 'application/json', ...init.headers },
      });
    } catch (err) {
      if (attempt >= this.opts.maxRetries) throw new DuneError(`network error on ${path}: ${(err as Error).message}`);
      await sleep(1000 * 2 ** attempt);
      return this.request(path, init, attempt + 1);
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= this.opts.maxRetries) {
        throw new DuneError(`Dune ${res.status} on ${path} after ${attempt} retries`, res.status, await res.text());
      }
      const retryAfter = Number(res.headers.get('retry-after'));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
      this.log.warn({ status: res.status, path, wait, attempt }, 'dune rate-limited/server error; backing off');
      await sleep(wait);
      return this.request(path, init, attempt + 1);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new DuneError(`Dune ${res.status} on ${path}`, res.status, body);
    return body as T;
  }

  /** Executes raw SQL (POST /v1/sql/execute), waits for completion, and pages through all rows. */
  async runSql(sql: string, performance: 'medium' | 'large' = 'medium'): Promise<DuneResult> {
    const { execution_id } = await this.request<{ execution_id: string }>('/sql/execute', {
      method: 'POST',
      body: JSON.stringify({ sql, performance }),
    });
    this.log.info({ executionId: execution_id }, 'dune execution started');

    const started = Date.now();
    let delay = 1000;
    let status: { state: string; error?: unknown; execution_cost_credits?: number };
    for (;;) {
      status = await this.request(`/execution/${execution_id}/status`);
      if (TERMINAL.has(status.state)) break;
      if (Date.now() - started > this.opts.timeoutMs) {
        throw new DuneError(`execution ${execution_id} timed out in state ${status.state}`);
      }
      await sleep(delay);
      delay = Math.min(delay * 1.5, this.opts.pollMaxMs);
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
  return readFileSync(resolve(repoRoot(), 'queries/dune', `${name}.sql`), 'utf8');
}

/** Date -> 'YYYY-MM-DD HH:MM:SS' (UTC) as expected by the SQL templates. */
export function duneTimestamp(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}
