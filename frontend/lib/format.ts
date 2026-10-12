// Display formatting only. Values arrive as exact decimal strings; rounding happens here, for presentation.

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });
const full = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const usdCompact = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 });

export const n = (v: string | number | null | undefined) => (v === null || v === undefined || v === '' ? null : Number(v));

export function fmtDeod(v: string | number | null | undefined, opts: { compact?: boolean; sign?: boolean } = {}) {
  const x = n(v);
  if (x === null) return '—';
  const s = (opts.compact ?? true) && Math.abs(x) >= 10_000 ? compact.format(x) : full.format(x);
  return opts.sign && x > 0 ? `+${s}` : s;
}

export function fmtUsd(v: string | number | null | undefined, compactMode = false) {
  const x = n(v);
  if (x === null) return '—';
  return compactMode && Math.abs(x) >= 10_000 ? usdCompact.format(x) : usd.format(x);
}

export function fmtPrice(v: string | number | null | undefined) {
  const x = n(v);
  return x === null ? '—' : `$${x.toPrecision(4)}`;
}

export const fmtInt = (v: string | number | null | undefined) => (n(v) === null ? '—' : full.format(n(v)!));

/** All times are shown in UTC to match on-chain block timestamps. */
export function fmtTime(v: string | null | undefined, withSeconds = false) {
  if (!v) return '—';
  const s = new Date(v).toISOString().replace('T', ' ');
  return `${s.slice(0, withSeconds ? 19 : 16)}`;
}

export function fmtAgo(v: string | null | undefined) {
  if (!v) return '—';
  const s = Math.round((Date.now() - new Date(v).getTime()) / 1000);
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export const VENUE_NAMES: Record<string, string> = {
  mexc: 'MEXC', toobit: 'Toobit',
  pancakeswap_v2: 'PancakeSwap V2', pancakeswap_v3: 'PancakeSwap V3',
};
export const venueName = (v: string) => VENUE_NAMES[v] ?? v;

/**
 * Compact number formatted by hand. Intl compact output differs between Node and browsers ("10.8M" vs "10.80M"),
 * which breaks hydration in client components; this is identical everywhere.
 */
export function compactNum(v: number): string {
  const units: [number, string][] = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  const abs = Math.abs(v);
  for (const [size, suffix] of units) {
    if (abs >= size) {
      const x = v / size;
      const digits = Math.abs(x) >= 100 ? 0 : Math.abs(x) >= 10 ? 1 : 2;
      const t = x.toFixed(digits);
      return `${t.includes('.') ? t.replace(/\.?0+$/, '') : t}${suffix}`;
    }
  }
  return abs >= 100 ? v.toFixed(0) : String(Number(v.toFixed(2)));
}
