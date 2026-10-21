import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { loadConfig, loadEnv } from '@deod/config';
import { closePool, getPool, migrate, refreshWalletSummary, deriveExchangeFlows, seedFromConfig } from '@deod/db';
import * as A from '@deod/analytics';
import { syncAllCompletedDays, syncToday, todayCooldownSeconds, SyncBusyError, SyncCooldownError } from '@deod/worker';
import { toCsv } from './csv.js';
import { getPrice } from './price.js';

const env = loadEnv();
const cfg = loadConfig();
const db = getPool();

const app = Fastify({
  logger: { level: env.LOG_LEVEL, base: { svc: 'api' } },
  // Reject unknown query params types early; Zod does the real validation per route.
  ajv: { customOptions: { coerceTypes: false } },
});

await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });

app.addHook('onRequest', async (req, reply) => {
  const key = env.INTERNAL_API_KEY;
  const path = req.url.split('?')[0]!;
  if (!key || !path.startsWith('/api/') || path === '/api/health' || path.startsWith('/api/admin/')) return;
  const got = String(req.headers['x-internal-key'] ?? '');
  if (got.length !== key.length || !timingSafeEqual(Buffer.from(got), Buffer.from(key))) return reply.code(401).send({ error: 'unauthorized' });
});

class BadRequest extends Error {}

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input);
  if (!r.success) throw new BadRequest(r.error.issues.map((i) => `${i.path.join('.') || 'query'}: ${i.message}`).join('; '));
  return r.data;
}

function windowOf(q: unknown) {
  try {
    return A.resolveWindow(parse(A.RangeQuery, q));
  } catch (e) {
    throw new BadRequest((e as Error).message);
  }
}

app.setErrorHandler((err, req, reply) => {
  if (err instanceof BadRequest) return reply.code(400).send({ error: err.message });
  if ((err as { statusCode?: number }).statusCode === 429) return reply.code(429).send({ error: 'rate limited' });
  req.log.error({ err }, 'request failed');
  return reply.code(500).send({ error: 'internal error' });
});

const Format = z.object({ format: z.enum(['json', 'csv']).default('json') });
// CSV exports return every matching row (the JSON list endpoints stay paginated).
const CSV_MAX_ROWS = 1_000_000;

function sendCsv(reply: FastifyReply, name: string, rows: Record<string, unknown>[]) {
  // Every exported row carries the raw tx hash plus a BscScan link built from it.
  const withLinks = rows.map((r) => (r.tx_hash ? { ...r, explorer_url: `${cfg.chain.explorer_tx_url}${r.tx_hash}` } : r));
  return reply
    .header('content-type', 'text/csv; charset=utf-8')
    .header('content-disposition', `attachment; filename="${name}-${new Date().toISOString().slice(0, 10)}.csv"`)
    .send(toCsv(withLinks));
}

const exchangeSlug = z.object({ slug: z.string().refine((s) => s in cfg.exchanges, 'unknown exchange') });
const walletParam = z.object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((s) => s.toLowerCase()) });

// ---------------------------------------------------------------------------
// Public read-only routes
// ---------------------------------------------------------------------------

app.get('/api/health', async () => {
  await db.query('SELECT 1');
  return { ok: true };
});

app.get('/api/meta', async () => ({
  chain: cfg.chain,
  token: cfg.token,
  exchanges: Object.entries(cfg.exchanges).map(([slug, e]) => ({ slug, name: e.name })),
  ...(await A.addressBook(db)),
  dataThrough: await A.dataThrough(db),
  freshnessNote:
    'Data is synced once per completed UTC day. Activity after "data through" appears after that day ends.',
  coverageNote:
    'Exchange flows cover the configured exchange-controlled addresses only. They do not necessarily represent all wallets controlled by each exchange.',
  traderNote:
    'PancakeSwap trader = transaction signer (tx_from). The Swap event recipient is shown separately; it is often a router or aggregator contract.',
}));

app.get('/api/price', async (req, reply) => {
  try {
    return await getPrice(cfg.token.address);
  } catch (err) {
    req.log.warn({ err: (err as Error).message }, 'price unavailable');
    return reply.code(503).send({ error: 'price unavailable' });
  }
});

app.get('/api/overview', async (req) => A.overview(db, windowOf(req.query)));

app.get('/api/flows/series', async (req) => {
  const { exchange } = parse(z.object({ exchange: z.string().regex(/^[a-z0-9_]+$/).optional() }).passthrough(), req.query);
  const w = windowOf(req.query);
  return { window: w, rows: await A.flowSeries(db, w, exchange) };
});

app.get('/api/activity', async (req, reply) => {
  const w = windowOf(req.query);
  const { format } = parse(Format.passthrough(), req.query);
  const { limit } = parse(z.object({ limit: z.coerce.number().int().min(1).max(1000).default(100) }).passthrough(), req.query);
  const rows = await A.listActivity(db, w, format === 'csv' ? CSV_MAX_ROWS : limit);
  return format === 'csv' ? sendCsv(reply, 'deod-all-activity', rows) : { window: w, rows };
});

app.get('/api/flows/hourly', async (req) => {
  const w = windowOf(req.query);
  return { window: w, rows: await A.hourlyActivity(db, w) };
});

app.get('/api/flows', async (req, reply) => {
  const w = windowOf(req.query);
  const f = parse(A.FlowFilter.passthrough(), req.query);
  const { format } = parse(Format.passthrough(), req.query);
  const result = await A.listFlows(db, w, format === 'csv' ? { ...f, limit: CSV_MAX_ROWS, offset: 0 } : f);
  return format === 'csv' ? sendCsv(reply, 'deod-exchange-flows', result.rows) : { window: w, ...result };
});

app.get('/api/exchanges/:slug', async (req) => {
  const { slug } = parse(exchangeSlug, req.params);
  const w = windowOf(req.query);
  const [stats, topIn, topOut, series] = await Promise.all([
    A.exchangeStats(db, slug, w),
    A.topExchangeWallets(db, slug, 'IN', w),
    A.topExchangeWallets(db, slug, 'OUT', w),
    A.flowSeries(db, w, slug),
  ]);
  return { exchange: { slug, name: cfg.exchanges[slug]!.name }, window: w, stats, topDepositors: topIn, topWithdrawers: topOut, series };
});

app.get('/api/pancakeswap', async (req) => {
  const { version } = parse(z.object({ version: z.enum(['2', '3', 'all']).default('all') }).passthrough(), req.query);
  const w = windowOf(req.query);
  const [stats, series, topBuyers, topSellers] = await Promise.all([
    A.pancakeStats(db, w, version),
    A.swapSeries(db, w, version),
    A.topWallets(db, w, { source: version === 'all' ? 'pancakeswap' : `pancakeswap_v${version}`, sort: 'buy', limit: 25 }),
    A.topWallets(db, w, { source: version === 'all' ? 'pancakeswap' : `pancakeswap_v${version}`, sort: 'sell', limit: 25 }),
  ]);
  return { version, window: w, stats, series, topBuyers, topSellers };
});

app.get('/api/swaps', async (req, reply) => {
  const w = windowOf(req.query);
  const f = parse(A.SwapFilter.passthrough(), req.query);
  const { format } = parse(Format.passthrough(), req.query);
  const result = await A.listSwaps(db, w, format === 'csv' ? { ...f, limit: CSV_MAX_ROWS, offset: 0 } : f);
  return format === 'csv' ? sendCsv(reply, 'deod-pancakeswap-swaps', result.rows) : { window: w, ...result };
});

app.get('/api/wallets/top', async (req, reply) => {
  const w = windowOf(req.query);
  const q = parse(A.TopWalletQuery.passthrough(), req.query);
  const { format } = parse(Format.passthrough(), req.query);
  const rows = await A.topWallets(db, w, q);
  return format === 'csv' ? sendCsv(reply, 'deod-top-wallets', rows) : { window: w, rows };
});

app.get('/api/wallets/:address', async (req) => {
  const { address } = parse(walletParam, req.params);
  const { limit, offset } = parse(
    z.object({ limit: z.coerce.number().int().min(1).max(1000).default(200), offset: z.coerce.number().int().min(0).default(0) }).passthrough(),
    req.query,
  );
  const [profile, timeline] = await Promise.all([A.walletProfile(db, address), A.walletTimeline(db, address, limit, offset)]);
  return { ...profile, timeline };
});

app.get('/api/wallets/:address/activity.csv', async (req, reply) => {
  const { address } = parse(walletParam, req.params);
  return sendCsv(reply, `deod-wallet-${address}`, await A.walletTimeline(db, address, CSV_MAX_ROWS, 0));
});

app.get('/api/search', async (req) => {
  const { q } = parse(z.object({ q: z.string().min(1).max(100) }), req.query);
  return A.search(db, q);
});

app.get('/api/sync/status', async () => A.syncStatus(db));

// "Update today": fetches the unfinished current UTC day on demand (Dune credits). The fetch runs in the background; the page polls GET.
interface RefreshJob { state: 'idle' | 'running' | 'done' | 'error'; startedAt?: string; finishedAt?: string; result?: { inserted: number; credits: number; to: string }; error?: string }
let refreshJob: RefreshJob = { state: 'idle' };
const refreshEnabled = env.REFRESH_TODAY_ENABLED === 'true';

app.get('/api/sync/today', async () => ({ enabled: refreshEnabled, cooldownSeconds: await todayCooldownSeconds(), job: refreshJob }));

app.post('/api/sync/today', async (_req, reply) => {
  if (!refreshEnabled) return reply.code(403).send({ error: 'Update today is switched off on this server' });
  if (refreshJob.state === 'running') return reply.code(409).send({ error: 'already running', job: refreshJob });
  const wait = await todayCooldownSeconds();
  if (wait > 0) return reply.code(429).send({ error: `Used a moment ago; try again in ${Math.ceil(wait / 60)} min`, cooldownSeconds: wait });
  refreshJob = { state: 'running', startedAt: new Date().toISOString() };
  void syncToday().then(
    (r) => { refreshJob = { ...refreshJob, state: 'done', finishedAt: new Date().toISOString(), result: r }; },
    (e) => {
      const msg = e instanceof SyncBusyError || e instanceof SyncCooldownError ? e.message : 'the fetch failed; see the backend log';
      if (!(e instanceof SyncBusyError || e instanceof SyncCooldownError)) app.log.error({ err: e instanceof Error ? e.message : String(e) }, 'update today failed');
      refreshJob = { ...refreshJob, state: 'error', finishedAt: new Date().toISOString(), error: msg };
    },
  );
  return reply.code(202).send({ started: true });
});

// ---------------------------------------------------------------------------
// Admin routes (bearer token)
// ---------------------------------------------------------------------------

function requireAdmin(req: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void) {
  const expected = env.ADMIN_TOKEN;
  const got = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const ok = !!expected && got.length === expected.length && timingSafeEqual(Buffer.from(got), Buffer.from(expected));
  if (!ok) {
    reply.code(401).send({ error: 'unauthorized' });
    return;
  }
  done();
}

app.register(async (admin) => {
  admin.addHook('onRequest', requireAdmin);
  await admin.register(rateLimit, { max: 30, timeWindow: '1 minute' });

  admin.post('/api/admin/sync', async (_req, reply) => {
    try {
      const daysFetched = await syncAllCompletedDays();
      return { ok: true, daysFetched, status: await A.syncStatus(db) };
    } catch (e) {
      if (e instanceof SyncBusyError) return reply.code(409).send({ error: e.message });
      throw e;
    }
  });

  const NewAddress = z.object({
    exchange: z.string().refine((s) => s in cfg.exchanges, 'unknown exchange'),
    address: z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((s) => s.toLowerCase()),
    address_type: z.string().min(1).max(50),
    notes: z.string().max(500).optional(),
    verified: z.boolean().default(false),
  });

  // Admin-added addresses are stored with source='admin'. Historical transfers for a new address
  // need a transfer backfill (CLI) because past Dune results only covered previously monitored addresses.
  admin.post('/api/admin/exchange-addresses', async (req, reply) => {
    const a = parse(NewAddress, req.body);
    const { rows } = await db.query(
      `INSERT INTO exchange_addresses (exchange, address, label, address_type, source, verified, notes)
       VALUES ($1, $2, $3, $4, 'admin', $5, $6) ON CONFLICT (chain, address) DO NOTHING RETURNING id`,
      [a.exchange, a.address, cfg.exchanges[a.exchange]!.name, a.address_type, a.verified, a.notes ?? null],
    );
    if (!rows.length) return reply.code(409).send({ error: 'address already exists' });
    return { ok: true, id: rows[0].id, note: 'Run a transfer backfill to load this address\'s history.' };
  });

  admin.patch('/api/admin/exchange-addresses/:address', async (req, reply) => {
    const { address } = parse(walletParam, req.params);
    const b = parse(z.object({ verified: z.boolean().optional(), monitored: z.boolean().optional() }), req.body);
    const { rowCount } = await db.query(
      `UPDATE exchange_addresses SET verified = coalesce($2, verified), monitored = coalesce($3, monitored), updated_at = now()
       WHERE address = $1`,
      [address, b.verified ?? null, b.monitored ?? null],
    );
    if (!rowCount) return reply.code(404).send({ error: 'not found' });
    if (b.monitored === false) {
      await db.query('DELETE FROM exchange_flows WHERE exchange_address = $1', [address]);
    } else {
      await deriveExchangeFlows(db);
    }
    await refreshWalletSummary(db);
    return { ok: true };
  });
});

await migrate(db);
await seedFromConfig(db);
await app.listen({ port: env.API_PORT, host: process.env.API_HOST ?? '127.0.0.1' });

// Graceful shutdown: stop accepting requests, let running ones finish, close the database pool. Triggered by Ctrl+C / SIGTERM /
// Ctrl+Break, or by a 'shutdown' message from `npm run dev` (signals do not work between processes on Windows, messages do).
let closing = false;
async function shutdown(reason: string) {
  if (closing) return;
  closing = true;
  app.log.info({ reason }, 'shutting down');
  try { await app.close(); } catch (err) { app.log.error({ err }, 'error while closing the server'); }
  await closePool();
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.on(sig, () => void shutdown(sig));
process.on('message', (m) => { if (m === 'shutdown') void shutdown('asked by the parent process'); });
