import { z } from 'zod';

// CoinGecko "decentrawood" (DEOD) lists this contract under platform binance-smart-chain (checked 2026-10-03).
// The free public endpoint is rate limited, so one cached request per TTL serves every viewer.
const PLATFORM = 'binance-smart-chain';
const TTL_MS = 60_000;
const STALE_MS = 10 * 60_000; // keep serving the last good price this long if CoinGecko is unreachable
const TIMEOUT_MS = 8_000;

const Entry = z.object({
  usd: z.number().positive().finite(),
  usd_market_cap: z.number().finite().nullish(),
  usd_24h_vol: z.number().finite().nullish(),
  usd_24h_change: z.number().finite().nullish(),
  last_updated_at: z.number().finite().nullish(),
});

export interface Price {
  usd: number;
  change24h: number | null;
  volume24h: number | null;
  marketCap: number | null;
  /** When CoinGecko last updated the price. */
  updatedAt: string | null;
  /** When this server last fetched it from CoinGecko. */
  fetchedAt: string;
  source: 'coingecko';
  /** True when CoinGecko could not be reached and this is the last good value. */
  stale: boolean;
}

let cached: { at: number; value: Price } | undefined;
let inflight: Promise<Price> | undefined;

async function fetchPrice(address: string): Promise<Price> {
  const qs = new URLSearchParams({
    contract_addresses: address,
    vs_currencies: 'usd',
    include_market_cap: 'true',
    include_24hr_vol: 'true',
    include_24hr_change: 'true',
    include_last_updated_at: 'true',
  });
  const res = await fetch(`https://api.coingecko.com/api/v3/simple/token_price/${PLATFORM}?${qs}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
  const body = (await res.json()) as Record<string, unknown>;
  const parsed = Entry.safeParse(body[address.toLowerCase()]);
  if (!parsed.success) throw new Error('CoinGecko returned no valid price for the DEOD contract');
  const e = parsed.data;
  return {
    usd: e.usd,
    change24h: e.usd_24h_change ?? null,
    volume24h: e.usd_24h_vol ?? null,
    marketCap: e.usd_market_cap ?? null,
    updatedAt: e.last_updated_at ? new Date(e.last_updated_at * 1000).toISOString() : null,
    fetchedAt: new Date().toISOString(),
    source: 'coingecko',
    stale: false,
  };
}

/** Cached DEOD/USD price. Throws only when there is no usable price at all. */
export async function getPrice(address: string): Promise<Price> {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.value;
  inflight ??= fetchPrice(address)
    .then((value) => {
      cached = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      inflight = undefined;
    });
  try {
    return await inflight;
  } catch (err) {
    if (cached && Date.now() - cached.at < STALE_MS) return { ...cached.value, stale: true };
    throw err;
  }
}
