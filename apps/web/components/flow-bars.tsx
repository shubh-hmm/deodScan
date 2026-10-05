import Link from 'next/link';
import { fmtDeod, fmtInt } from '@/lib/format';
import { Empty } from '@/components/ui';

interface Row { exchange: string; name: string; inflow: string; outflow: string; net: string; deposits: string | number; withdrawals: string | number }

/**
 * Exchange comparison: for each exchange a pair of horizontal bars (IN blue, OUT orange) on one shared scale,
 * with the value at each bar's tip, so the exchanges can be compared at a glance. Net is shown as a number only.
 */
export function FlowBars({ rows }: { rows: Row[] }) {
  const max = Math.max(0, ...rows.flatMap((r) => [Number(r.inflow), Number(r.outflow)]));
  if (!rows.length || max === 0) return <Empty />;
  const bar = (v: string, color: string, label: string) => (
    <div className="flex items-center gap-2.5">
      <span className="w-8 text-[10.5px] font-semibold tracking-wide text-muted">{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <div className={`h-2.5 rounded-r-md ${color}`} style={{ width: `${Math.max((Number(v) / max) * 78, Number(v) > 0 ? 0.8 : 0)}%` }} />
        <span className="num text-xs text-ink-2" title={`${v} DEOD`}>{fmtDeod(v)}</span>
      </div>
    </div>
  );
  return (
    <ul>
      {rows.map((r) => (
        <li key={r.exchange} className="border-b border-line px-4 py-3.5 last:border-b-0">
          <div className="mb-2.5 flex items-baseline justify-between gap-3">
            <Link className="link text-sm font-semibold" href={`/${r.name}`}>{r.name}</Link>
            <span className="text-xs text-muted">
              Net <span className="num font-semibold text-ink">{fmtDeod(r.net, { sign: true })}</span>
            </span>
          </div>
          <div className="space-y-1.5">
            {bar(r.inflow, 'bg-s1', 'IN')}
            {bar(r.outflow, 'bg-s2', 'OUT')}
          </div>
          <div className="mt-2 text-[11px] text-muted">
            <span className="num">{fmtInt(r.deposits)}</span> deposits · <span className="num">{fmtInt(r.withdrawals)}</span> withdrawals
          </div>
        </li>
      ))}
    </ul>
  );
}
