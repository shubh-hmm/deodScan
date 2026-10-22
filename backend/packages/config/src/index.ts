import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';
import dotenv from 'dotenv';

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 20-byte hex address')
  .transform((s) => s.toLowerCase());

const ExchangeAddress = z.object({
  address,
  address_type: z.string(),
  source: z.string(),
  verified: z.boolean(),
  dune_label: z.string().optional(),
  note: z.string().optional(),
});

const Pool = z.object({
  address,
  pair: z.string(),
  token0: z.string(),
  token1: z.string(),
  fee_tier: z.number().int().optional(),
  verification: z.string().optional(),
});

const ConfigSchema = z.object({
  chain: z.object({
    name: z.string(),
    // The platform is BNB Chain only; reject anything else at load time.
    slug: z.literal('bnb'),
    explorer_tx_url: z.string().url(),
    explorer_address_url: z.string().url(),
  }),
  token: z.object({
    symbol: z.string(),
    name: z.string(),
    chain: z.literal('bnb'),
    address,
    decimals: z.number().int().min(0).max(36),
  }),
  quote_tokens: z.record(
    z.string(),
    z.object({ address, decimals: z.number().int().min(0).max(36), usd_peg: z.boolean() }),
  ),
  exchanges: z.record(
    z.string().regex(/^[a-z0-9_]+$/),
    z.object({ name: z.string(), addresses: z.array(ExchangeAddress).min(1) }),
  ),
  pancakeswap: z.object({
    v2: z.object({ factory: address, pools: z.array(Pool) }),
    v3: z.object({ factory: address, pools: z.array(Pool) }),
  }),
});

export type DeodConfig = z.infer<typeof ConfigSchema>;

/** Walks up from this file to the backend folder (the directory holding config/deod.yaml, queries/ and .env). */
export function backendRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(resolve(dir, 'config/deod.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('Could not locate the backend folder (config/deod.yaml)');
    dir = parent;
  }
}

let cached: DeodConfig | undefined;

export function loadConfig(): DeodConfig {
  if (cached) return cached;
  const raw = parse(readFileSync(resolve(backendRoot(), 'config/deod.yaml'), 'utf8'));
  cached = ConfigSchema.parse(raw);
  return cached;
}

const Severity = z.enum(['low', 'medium', 'high']);
const AlertsSchema = z.object({
  scan: z.object({ max_alert_age_days: z.number().positive() }),
  rules: z.object({
    large_transfer: z.object({ enabled: z.boolean(), name: z.string(), severity: Severity, min_amount: z.number().positive() }),
    large_swap: z.object({ enabled: z.boolean(), name: z.string(), severity: Severity, min_amount: z.number().positive() }),
    flow_spike: z.object({
      enabled: z.boolean(), name: z.string(), severity: Severity,
      multiplier: z.number().positive(), baseline_days: z.number().int().min(1), min_history_days: z.number().int().min(1), min_amount: z.number().positive(),
    }),
  }),
  watched_wallet: z.object({ severity: Severity }),
});

export type AlertsConfig = z.infer<typeof AlertsSchema>;

/** Alert thresholds (config/alerts.yaml). Read fresh each time so a scan always uses the current file. */
export function loadAlertsConfig(): AlertsConfig {
  return AlertsSchema.parse(parse(readFileSync(resolve(backendRoot(), 'config/alerts.yaml'), 'utf8')));
}

const EnvSchema = z.object({
  DUNE_API_KEY: z.string().optional(),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  ADMIN_TOKEN: z.string().optional(),
  // When set, /api/* (except /api/health and the bearer-protected /api/admin/*) answers only requests with this value in the x-internal-key
  // header. The dashboard server sends it, so the API stays unusable even if its address becomes public. Set the same value in frontend/.env.local.
  INTERNAL_API_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(16).optional()),
  // The dashboard's "Update today" button. Set to false on a public server (anyone could press it and spend Dune credits).
  REFRESH_TODAY_ENABLED: z.enum(['true', 'false']).default('true'),
  // Telegram bot (optional). People send TELEGRAM_ACCESS_CODE to the bot to be let in, then choose whether to receive alerts. Both values are
  // checked where they are used (worker/src/telegram), so a typo can only switch the bot off, never stop the backend from starting.
  TELEGRAM_BOT_TOKEN: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  TELEGRAM_ACCESS_CODE: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  // "Ask DEODScan AI" (optional). The assistant uses OpenAI's API; without OPENAI_API_KEY it is simply off. OPENAI_MODEL must be a model your key can use
  // (run: npx tsx worker/src/cli.ts ask-check). ASK_DAILY_LIMIT caps the questions per UTC day, so the cost cannot run away.
  OPENAI_API_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  OPENAI_MODEL: z.preprocess((v) => (v === '' ? undefined : v), z.string().default('gpt-4.1')),
  ASK_DAILY_LIMIT: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().min(1).max(10000).default(100)),
  API_PORT: z.coerce.number().int().default(4000),
  LOG_LEVEL: z.string().default('info'),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(): Env {
  dotenv.config({ path: resolve(backendRoot(), '.env'), quiet: true });
  return EnvSchema.parse(process.env);
}

/** All monitored pools with their version, flattened. */
export function monitoredPools(cfg = loadConfig()) {
  return [
    ...cfg.pancakeswap.v2.pools.map((p) => ({ ...p, version: '2' as const })),
    ...cfg.pancakeswap.v3.pools.map((p) => ({ ...p, version: '3' as const })),
  ];
}
