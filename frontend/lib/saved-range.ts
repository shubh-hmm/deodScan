// The time period (1H ... 30D, All, or a custom date range) that the user last picked, remembered in a cookie so it follows them from
// page to page. Pure functions, shared by the server (reads the cookie) and the browser (writes it). The cookie holds no secret.

export const RANGE_COOKIE = 'deod_range';

const PRESETS = ['1h', '6h', '24h', '7d', '30d', 'all', 'custom'];
const DAY = /^\d{4}-\d{2}-\d{2}/;

export interface SavedRange { range: string; from?: string; to?: string }

/** Picks a valid period out of anything shaped like query parameters. Returns null when there is none. */
export function pickRange(p: { range?: string | null; from?: string | null; to?: string | null }): SavedRange | null {
  const range = p.range ?? '';
  if (!PRESETS.includes(range)) return null;
  if (range !== 'custom') return { range };
  if (!p.from || !DAY.test(p.from)) return null;
  const out: SavedRange = { range, from: p.from.slice(0, 10) };
  if (p.to && DAY.test(p.to)) out.to = p.to.slice(0, 10);
  return out;
}

export function encodeRange(r: SavedRange): string {
  const q = new URLSearchParams({ range: r.range });
  if (r.from) q.set('from', r.from);
  if (r.to) q.set('to', r.to);
  return q.toString();
}

/** Reads the cookie value back. Anything unexpected is ignored (null), never an error. */
export function decodeRange(raw: string | undefined): SavedRange | null {
  if (!raw) return null;
  let value = raw;
  try { value = decodeURIComponent(raw); } catch { /* use as is */ }
  const q = new URLSearchParams(value);
  return pickRange({ range: q.get('range'), from: q.get('from'), to: q.get('to') });
}
