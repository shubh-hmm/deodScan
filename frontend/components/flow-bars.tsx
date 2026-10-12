import Link from 'next/link';
import { fmtDeod, fmtInt } from '@/lib/format';
import { Icons } from '@/components/icons';
import { Empty } from '@/components/ui';

interface Row { exchange: string; name: string; inflow: string; outflow: string; net: string; deposits: string | number; withdrawals: string | number }

/**
 * One card per exchange: a pair of horizontal bars (IN blue, OUT orange) on a scale shared by every exchange, with the
 * value at each bar's tip, so the exchanges compare at a glance. Net is a plain number; it is never coloured good or bad.
 */
export function ExchangeCards({ rows }: { rows: Row[] }) {
  const max = Math.max(0, ...rows.flatMap((r) => [Number(r.inflow), Number(r.outflow)]));
  if (!rows.length || max === 0) return <Empty />;
  const bar = (v: string, color: string, label: string, icon: React.ReactNode) => (
    <div className="flex items-center gap-2.5">
      <span className="flex w-11 items-center gap-1 text-[10.5px] font-semibold tracking-wide text-muted">{icon}{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <div className={`h-2.5 rounded-r-md ${color}`} style={{ width: `${Math.max((Number(v) / max) * 74, Number(v) > 0 ? 0.8 : 0)}%` }} />
        <span className="num text-xs text-ink-2" title={`${v} DEOD`}>{fmtDeod(v)}</span>
      </div>
    </div>
  );
  return (
    <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
      {rows.map((r) => (
        <div key={r.exchange} className="card tile rise p-4">
          <div className="mb-3 flex items-center gap-3">
            <span className="badge-icon brand">{Icons.exchange}</span>
            <div className="min-w-0 flex-1">
              <Link className="text-sm font-semibold text-ink hover:underline" href={`/${r.name}`}>{r.name}</Link>
              <div className="text-[11px] text-muted">
                <span className="num">{fmtInt(r.deposits)}</span> deposits · <span className="num">{fmtInt(r.withdrawals)}</span> withdrawals
              </div>
            </div>
            <div className="text-right">
              <div className="text-[11px] text-muted">Net flow</div>
              <div className="num text-[15px] font-semibold text-ink">{fmtDeod(r.net, { sign: true })}</div>
            </div>
          </div>
          <div className="space-y-2">
            {bar(r.inflow, 'bg-s1', 'IN', <span className="text-s1">{Icons.down}</span>)}
            {bar(r.outflow, 'bg-s2', 'OUT', <span className="text-s2">{Icons.up}</span>)}
          </div>
        </div>
      ))}
    </div>
  );
}
