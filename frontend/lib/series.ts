import type { CumPoint, PairPoint } from '@/components/charts';

/** Sums rows per bucket into {a, b} and fills empty buckets between window start and end with zeros. */
export function pairSeries<T extends { bucket: string }>(
  rows: T[],
  window: { from: string | null; to: string; bucket: 'hour' | 'day' },
  a: (r: T) => number,
  b: (r: T) => number,
): PairPoint[] {
  const step = window.bucket === 'hour' ? 3600e3 : 86400e3;
  const trunc = (t: number) => (window.bucket === 'hour' ? Math.floor(t / step) * step : Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), new Date(t).getUTCDate()));
  const acc = new Map<number, PairPoint>();
  for (const r of rows) {
    const k = trunc(new Date(r.bucket).getTime());
    const p = acc.get(k) ?? { bucket: new Date(k).toISOString(), a: 0, b: 0 };
    p.a += a(r);
    p.b += b(r);
    acc.set(k, p);
  }
  if (!acc.size) return [];
  const start = window.from ? trunc(new Date(window.from).getTime()) : Math.min(...acc.keys());
  const end = trunc(new Date(window.to).getTime());
  const out: PairPoint[] = [];
  for (let t = start; t <= end; t += step) out.push(acc.get(t) ?? { bucket: new Date(t).toISOString(), a: 0, b: 0 });
  return out;
}

/** Adds a running total of (a − b) from the start of the window. Used for the cumulative net flow chart. */
export function withCumulative(points: PairPoint[]): CumPoint[] {
  let run = 0;
  return points.map((p) => {
    run += p.a - p.b;
    return { ...p, cum: run };
  });
}
