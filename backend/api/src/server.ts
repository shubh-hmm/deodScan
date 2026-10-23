import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { loadConfig, loadEnv } from '@deod/config';
import { closeDb, getDb, isDuplicateKey, migrate, nextIds, refreshWalletSummary, deriveExchangeFlows, seedFromConfig } from '@deod/db';
import * as A from '@deod/analytics';
import { syncAllCompletedDays, syncToday, todayCooldownSeconds, todayUsage, autoConfigFromEnv, SyncLimitError, startBotFromEnv, apiFromEnv, MIN_ACCESS_CODE_LENGTH, SyncBusyError, SyncCooldownError } from '@deod/worker';
import { createAsk, LlmError } from '@deod/ask';
import { toCsv } from './csv.js';
import { getPrice } from './price.js';

const env = loadEnv();
const cfg = loadConfig();
// A database operation that runs for more than a minute is a mistake or an attack, not a dashboard page: the database cancels it, so one bad
// request cannot pile up and exhaust the connections.
const db = getDb({ queryTimeoutMs: 60_000 });

const app = Fastify({
  logger: { level: env.LOG_LEVEL, base: { svc: 'api' } },
  // Reject unknown query params types early; Zod does the real validation per route.
  ajv: { customOptions: { coerceTypes: false } },
  // Requests are small (the biggest body is a question of at most 2,000 characters), so a large body is refused early; and no request may hold
  // a connection for more than 2.5 minutes (the slowest legitimate one is an AI question).
  bodyLimit: 100_000,
  requestTimeout: 150_000,
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

// The short periods end at the newest fetched data (see A.dataAnchor). Looked up at most every 20 s.
let anchor: { at: number; value: Date | null } = { at: 0, value: null };
app.addHook('preHandler', async (req) => {
  if (!req.url.startsWith('/api/') || Date.now() - anchor.at < 20_000) return;
  anchor = { at: Date.now(), value: await A.dataAnchor(db).catch(() => anchor.value) };
});

function windowOf(q: unknown) {
  try {
    return A.resolveWindow(parse(A.RangeQuery, q), new Date(), anchor.value);
  } catch (e) {
    throw new BadRequest((e as Error).message);
  }
}

app.setErrorHandler((err, req, reply) => {
  if (err instanceof BadRequest) return reply.code(400).send({ error: err.message });
  const status = (err as { statusCode?: number }).statusCode;
  if (status === 429) return reply.code(429).send({ error: 'rate limited' });
  // The server's own refusals of a bad request (broken JSON, body too large, wrong content type) are the caller's mistake: answer with that
  // 4xx and a fixed message, never a 500 and never the internal wording.
  if (status && status >= 400 && status < 500) return reply.code(status).send({ error: status === 413 ? 'request too large' : status === 415 ? 'unsupported content type' : 'invalid request' });
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

// Health check for uptime monitors: fails (HTTP 500) when the database does not answer; reports how old the synced data is, which a monitor can
// alert on (the daily sync stopped) without the API itself being unhealthy.
app.get('/api/health', { config: { rateLimit: false } }, async () => {
  await db.command({ ping: 1 });
  const through = await A.dataThrough(db).catch(() => null);
  const ageHours = through ? Math.round((Date.now() - through.getTime()) / 36e5) : null;
  return { ok: true, dataThrough: through ? through.toISOString() : null, dataAgeHours: ageHours, dataStale: ageHours === null || ageHours > 48 };
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
// Plain-language summary of the same period, written by fixed rules from the overview numbers (no AI).
app.get('/api/summary', async (req) => A.summarize(db, windowOf(req.query)));

// "Ask DEODScan AI": the model only picks read-only queries and words the answer; every figure is checked against the data before it is shown.
// Off (and harmless) until OPENAI_API_KEY is set in backend/.env. The browser never sees the key; the dashboard reaches these routes through its signed-in proxy.
const ask = createAsk(db);
const AskBody = z.object({
  question: z.string().max(2000),
  defaultRange: z.enum(['1h', '6h', '24h', '7d', '30d', 'all']).optional(),
  // The last few exchanges of this conversation, so a follow-up such as "show me the addresses" has something to refer to.
  history: z.array(z.object({ question: z.string().max(500), answer: z.string().max(3000) })).max(3).optional(),
});
const ASK_STATUS: Record<LlmError['kind'], number> = { auth: 503, quota: 429, rate_limit: 429, model: 502, timeout: 504, other: 400 };
app.get('/api/ask/status', async () => ask.status());
app.post('/api/ask', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
  const body = parse(AskBody, req.body);
  try {
    // One question may take at most two minutes in total (several model calls), however slow the AI service is.
    return await ask.ask(body.question, { defaultRange: body.defaultRange, history: body.history, signal: AbortSignal.timeout(120_000) });
  } catch (e) {
    if (e instanceof LlmError) return reply.code(ASK_STATUS[e.kind]).send({ error: e.message, kind: e.kind });
    throw e;
  }
});

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

// Alerts and wallet monitoring. Alerts are created by the worker's scan of stored data; these routes only read them and manage the watchlist.
app.get('/api/alerts', async (req) => A.listAlerts(db, parse(A.AlertFilter.passthrough(), req.query), cfg.chain.explorer_tx_url));
app.get('/api/alert-rules', async () => A.alertRules(db));
app.get('/api/watchlist', async () => A.listWatched(db));

// Telegram bot status for the Alerts page (never returns the token or the access code).
let botName: { at: number; name: string | null } | null = null;
app.get('/api/telegram/status', async () => {
  const code = env.TELEGRAM_ACCESS_CODE;
  const configured = !!env.TELEGRAM_BOT_TOKEN && !!code && code.length >= MIN_ACCESS_CODE_LENGTH;
  if (configured && (!botName || Date.now() - botName.at > 600_000)) {
    // A malformed token makes apiFromEnv() throw: that must only mean "no bot name", never an error on this route.
    let name: string | null = null;
    try { name = (await apiFromEnv()?.getMe().then((m) => m.username, () => null)) ?? null; } catch { name = null; }
    botName = { at: Date.now(), name };
  }
  const users = db.collection('telegram_users');
  const [allowed, subscribed] = await Promise.all([users.countDocuments({ status: { $in: ['authorized', 'subscribed'] } }), users.countDocuments({ status: 'subscribed' })]);
  return { configured, botUsername: configured ? botName?.name ?? null : null, allowed, subscribed };
});
app.post('/api/watchlist', async (req, reply) => {
  const row = await A.upsertWatched(db, parse(A.WatchInput, req.body));
  if (!row) return reply.code(409).send({ error: `The watchlist is full (${A.MAX_WATCHED} wallets). Remove one first.` });
  return { ok: true, wallet: row, limitation: A.WATCH_LIMITATION };
});
app.delete('/api/watchlist/:address', async (req, reply) => {
  const { address } = parse(walletParam, req.params);
  return (await A.removeWatched(db, address)) ? { ok: true } : reply.code(404).send({ error: 'not on the watchlist' });
});

// "Update today": fetches the unfinished current UTC day on demand (Dune credits). The fetch runs in the background; the page polls GET.
interface RefreshJob { state: 'idle' | 'running' | 'done' | 'error'; startedAt?: string; finishedAt?: string; result?: { inserted: number; credits: number; to: string }; error?: string }
let refreshJob: RefreshJob = { state: 'idle' };
const refreshEnabled = env.REFRESH_TODAY_ENABLED === 'true';

// When the worker updates today's data by itself (UTC times), so the button can say so. Only what the worker is configured to do; whether a
// worker is running is not known to the API.
const autoInfo = () => { const c = autoConfigFromEnv(); return { enabled: c.enabled, timesUtc: c.slots.map((s) => `${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}`) }; };

app.get('/api/sync/today', async () => ({ enabled: refreshEnabled, cooldownSeconds: await todayCooldownSeconds(), usage: await todayUsage(), auto: autoInfo(), job: refreshJob }));

app.post('/api/sync/today', async (_req, reply) => {
  if (!refreshEnabled) return reply.code(403).send({ error: 'Update today is switched off on this server' });
  if (refreshJob.state === 'running') return reply.code(409).send({ error: 'already running', job: refreshJob });
  const usage = await todayUsage();
  if (usage.remaining <= 0) return reply.code(429).send({ error: new SyncLimitError(usage.max).message, usage });
  const wait = await todayCooldownSeconds();
  if (wait > 0) return reply.code(429).send({ error: `Used a moment ago; try again in ${Math.ceil(wait / 60)} min`, cooldownSeconds: wait });
  refreshJob = { state: 'running', startedAt: new Date().toISOString() };
  void syncToday().then(
    (r) => { refreshJob = { ...refreshJob, state: 'done', finishedAt: new Date().toISOString(), result: r }; },
    (e) => {
      const known = e instanceof SyncBusyError || e instanceof SyncCooldownError || e instanceof SyncLimitError;
      const msg = known ? e.message : 'the fetch failed; see the backend log';
      if (!known) app.log.error({ err: e instanceof Error ? e.message : String(e) }, 'update today failed');
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
    const id = await nextIds(db, 'exchange_addresses');
    try {
      await db.collection('exchange_addresses').insertOne({
        _id: id as never, exchange: a.exchange, chain: 'bnb', address: a.address, label: cfg.exchanges[a.exchange]!.name, address_type: a.address_type, source: 'admin',
        verified: a.verified, monitored: true, dune_label: null, notes: a.notes ?? null, created_at: new Date(), updated_at: new Date(),
      });
    } catch (e) {
      if (isDuplicateKey(e)) return reply.code(409).send({ error: 'address already exists' });
      throw e;
    }
    return { ok: true, id, note: "Run a transfer backfill to load this address's history." };
  });

  admin.patch('/api/admin/exchange-addresses/:address', async (req, reply) => {
    const { address } = parse(walletParam, req.params);
    const b = parse(z.object({ verified: z.boolean().optional(), monitored: z.boolean().optional() }), req.body);
    const updated = await db.collection('exchange_addresses').updateOne(
      { address },
      { $set: { ...(b.verified !== undefined ? { verified: b.verified } : {}), ...(b.monitored !== undefined ? { monitored: b.monitored } : {}), updated_at: new Date() } },
    );
    if (!updated.matchedCount) return reply.code(404).send({ error: 'not found' });
    if (b.monitored === false) {
      await db.collection('exchange_flows').deleteMany({ exchange_address: address });
    } else {
      await deriveExchangeFlows(db);
    }
    await refreshWalletSummary(db);
    return { ok: true };
  });
});

await migrate(db);
await seedFromConfig(db);
// Listening beyond this computer without the shared key would put the whole API (every wallet, every CSV export) on the network for anyone who
// can reach it. Refuse that, instead of trusting that someone remembers to set the key.
const host = process.env.API_HOST ?? '127.0.0.1';
if (!['127.0.0.1', '::1', 'localhost'].includes(host) && !env.INTERNAL_API_KEY) {
  app.log.fatal({ host }, 'API_HOST is not this computer, but INTERNAL_API_KEY is not set: refusing to start. Set INTERNAL_API_KEY (and the same value in the dashboard) or listen on 127.0.0.1');
  process.exit(1);
}
await app.listen({ port: env.API_PORT, host });
// The Telegram bot (people send the access code, then opt in to alerts) is read in the background by this process. Off unless configured.
const bot = startBotFromEnv(db, app.log);

// Graceful shutdown: stop accepting requests, let running ones finish, close the database pool. Triggered by Ctrl+C / SIGTERM /
// Ctrl+Break, or by a 'shutdown' message from `npm run dev` (signals do not work between processes on Windows, messages do).
let closing = false;
async function shutdown(reason: string, exitCode = 0) {
  if (closing) return;
  closing = true;
  app.log.info({ reason }, 'shutting down');
  try { await bot?.stop(); } catch (err) { app.log.error({ err }, 'error while stopping the telegram bot'); }
  try { await app.close(); } catch (err) { app.log.error({ err }, 'error while closing the server'); }
  await closeDb();
  process.exit(exitCode);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.on(sig, () => void shutdown(sig));
// A stray failed promise (say a Telegram call) is logged and the server keeps serving. An error nobody caught means the process may be in an
// unknown state: close down in an orderly way and exit with an error, so the process manager (pm2, systemd, Docker, the host) starts a fresh one.
process.on('unhandledRejection', (err) => app.log.error({ err }, 'unhandled promise rejection (ignored, the server keeps running)'));
process.on('uncaughtException', (err) => {
  app.log.fatal({ err }, 'uncaught exception: shutting down so the process manager can restart the API');
  setTimeout(() => process.exit(1), 5000).unref();
  void shutdown('uncaught exception', 1);
});
process.on('message', (m) => { if (m === 'shutdown') void shutdown('asked by the parent process'); });
