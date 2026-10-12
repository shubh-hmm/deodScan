import Link from 'next/link';

const RANGES = [
  ['1h', '1H'], ['6h', '6H'], ['24h', '24H'], ['7d', '7D'], ['30d', '30D'], ['all', 'All'],
] as const;

/** Preset time ranges as a segmented control (links preserve other params), plus a custom UTC range in a popover. */
export function RangePicker({ path, params }: { path: string; params: Record<string, string | undefined> }) {
  const current = params.range ?? '24h';
  const keep = (k: string) => !['range', 'from', 'to', 'offset'].includes(k);
  const href = (range: string) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v && keep(k)) q.set(k, v);
    q.set('range', range);
    return `${path}?${q}`;
  };
  return (
    <div className="seg" role="group" aria-label="Time range">
      {RANGES.map(([k, label]) => (
        <Link key={k} href={href(k)} aria-current={current === k ? 'true' : undefined}>{label}</Link>
      ))}
      <details className="relative">
        <summary className={current === 'custom' ? 'on' : ''}>Custom</summary>
        <form action={path} className="card absolute right-0 top-[calc(100%+8px)] z-30 flex w-72 flex-col gap-3 p-4 text-xs text-ink-2">
          {Object.entries(params).map(([k, v]) => (v && keep(k) ? <input key={k} type="hidden" name={k} value={v} /> : null))}
          <input type="hidden" name="range" value="custom" />
          <label className="flex flex-col gap-1">From (UTC)
            <input type="date" name="from" defaultValue={params.from?.slice(0, 10)} required />
          </label>
          <label className="flex flex-col gap-1">To (UTC)
            <input type="date" name="to" defaultValue={params.to?.slice(0, 10)} />
          </label>
          <button className="btn">Apply range</button>
        </form>
      </details>
    </div>
  );
}

/** Range params forwarded to the API. */
export function rangeParams(p: Record<string, string | undefined>) {
  return { range: p.range ?? '24h', from: p.from, to: p.to };
}

export function windowLabel(w: { from: string | null; to: string; range: string }) {
  if (w.range === 'all') return 'All time';
  const map: Record<string, string> = { '1h': 'Last 1 hour', '6h': 'Last 6 hours', '24h': 'Last 24 hours', '7d': 'Last 7 days', '30d': 'Last 30 days' };
  return map[w.range] ?? `${w.from?.slice(0, 10)} → ${w.to.slice(0, 10)} (UTC)`;
}
