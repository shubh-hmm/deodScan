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

const EnvSchema = z.object({
  DUNE_API_KEY: z.string().optional(),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  ADMIN_TOKEN: z.string().optional(),
  // When set, /api/* (except /api/health and the bearer-protected /api/admin/*) answers only requests with this value in the x-internal-key
  // header. The dashboard server sends it, so the API stays unusable even if its address becomes public. Set the same value in frontend/.env.local.
  INTERNAL_API_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(16).optional()),
  // The dashboard's "Update today" button. Set to false on a public server (anyone could press it and spend Dune credits).
  REFRESH_TODAY_ENABLED: z.enum(['true', 'false']).default('true'),
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
