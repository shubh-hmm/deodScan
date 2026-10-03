import Link from 'next/link';

const RANGES = [
  ['1h', '1H'], ['6h', '6H'], ['24h', '24H'], ['7d', '7D'], ['30d', '30D'], ['all', 'All'],
] as const;

/** Preset time ranges as links (preserving other params) plus a custom UTC date range. */
export function RangePicker({ path, params }: { path: string; params: Record<string, string | undefined> }) {
  const current = params.range ?? '24h';
  const href = (range: string) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v && !['range', 'from', 'to', 'offset'].includes(k)) q.set(k, v);
    q.set('range', range);
    return `${path}?${q}`;
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex overflow-hidden rounded-md border border-line text-xs">
        {RANGES.map(([k, label]) => (
          <Link key={k} href={href(k)}
            className={`px-3 py-1.5 ${current === k ? 'bg-surface-2 font-semibold text-ink' : 'text-ink-2 hover:bg-surface-2'}`}>
            {label}
          </Link>
        ))}
      </div>
      <form action={path} className="flex items-center gap-1.5 text-xs text-ink-2">
        {Object.entries(params).map(([k, v]) =>
          v && !['range', 'from', 'to', 'offset'].includes(k) ? <input key={k} type="hidden" name={k} value={v} /> : null)}
        <input type="hidden" name="range" value="custom" />
        <input type="date" name="from" defaultValue={params.from?.slice(0, 10)} required aria-label="From (UTC)" />
        <span>→</span>
        <input type="date" name="to" defaultValue={params.to?.slice(0, 10)} aria-label="To (UTC)" />
        <button className={`rounded-md border border-line px-2 py-1 ${current === 'custom' ? 'bg-surface-2 text-ink' : 'hover:bg-surface-2'}`}>Apply</button>
      </form>
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
