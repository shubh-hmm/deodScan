import 'server-only';
import { cookies } from 'next/headers';
import { RANGE_COOKIE, decodeRange } from '@/lib/saved-range';

const BASE = process.env.API_BASE_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** Server-side fetch to the backend API. The browser never talks to the API or Dune directly. */
export async function api<T = any>(path: string, params?: Record<string, string | undefined>): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== '') qs.set(k, v);
  const url = `${BASE}${path}${qs.size ? `?${qs}` : ''}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.error ?? `API ${res.status}`, res.status);
  }
  return res.json() as Promise<T>;
}

export type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Flattens Next's searchParams to single strings (first value wins).
 * A page whose address has no time period of its own starts on the period the user last picked (remembered in a cookie), so a
 * choice made on one page holds on every other page. A period in the address always wins.
 */
export async function flat(sp: SearchParams): Promise<Record<string, string | undefined>> {
  const o = await sp;
  const out: Record<string, string | undefined> = Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
  if (!out.range) {
    const saved = decodeRange((await cookies()).get(RANGE_COOKIE)?.value);
    if (saved) { out.range = saved.range; if (saved.from) out.from = saved.from; if (saved.to) out.to = saved.to; }
  }
  return out;
}

export interface Meta {
  chain: { name: string; explorer_tx_url: string; explorer_address_url: string };
  token: { symbol: string; address: string; decimals: number };
  exchanges: { slug: string; name: string }[];
  exchangeAddresses: { address: string; exchange: string; name: string; address_type: string; verified: boolean; monitored: boolean; dune_label: string | null; notes: string | null; source: string }[];
  pools: { address: string; version: string; pair: string; fee_tier: number | null; quote_symbol: string; verification: string | null }[];
  coverageNote: string;
  traderNote: string;
  dataThrough: string | null;
  freshnessNote: string;
}

let metaCache: { at: number; value: Meta } | undefined;
export async function meta(): Promise<Meta> {
  if (metaCache && Date.now() - metaCache.at < 60_000) return metaCache.value;
  const value = await api<Meta>('/api/meta');
  metaCache = { at: Date.now(), value };
  return value;
}

/** Evidence-based labels only: configured exchange addresses and configured pools. */
export function labelMap(m: Meta): Map<string, string> {
  const map = new Map<string, string>();
  for (const a of m.exchangeAddresses) map.set(a.address, `${a.name}${a.dune_label ? ` (${a.dune_label})` : ''}`);
  for (const p of m.pools) map.set(p.address, `PancakeSwap V${p.version} ${p.pair}`);
  map.set(m.token.address, `${m.token.symbol} token contract`);
  return map;
}

/** Drops undefined/empty values so they can go into URLSearchParams. */
export function clean(o: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')) as Record<string, string>;
}
