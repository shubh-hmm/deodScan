import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';
import { fmtDeod, short } from '@/lib/format';
import { Icons } from '@/components/icons';

export function Card({ title, children, actions, className = '' }: { title?: ReactNode; children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <section className={`card rise min-w-0 ${className}`}>
      {(title || actions) && (
        <header className="card-head flex items-center justify-between gap-4 px-4 py-3">
          <h2 className="text-[13px] font-semibold tracking-wide text-ink">{title}</h2>
          {actions && <div className="flex items-center gap-3 text-xs">{actions}</div>}
        </header>
      )}
      <div className="overflow-x-auto">{children}</div>
    </section>
  );
}

/** Stat tile: label, value, optional sub-line and a decorative trend (the numbers carry the meaning). */
export function Stat({ label, value, sub, title, tone, trend, icon, delta }: {
  label: string; value: ReactNode; sub?: ReactNode; title?: string; tone?: 'in' | 'out'; trend?: ReactNode; icon?: ReactNode; delta?: string;
}) {
  return (
    <div className="card tile rise min-w-0 px-4 pb-3 pt-3.5" title={title}>
      <div className="flex items-center gap-3">
        {icon && <span className={`badge-icon ${tone ?? 'cyan'}`}>{icon}</span>}
        <div className="min-w-0">
          <div className="text-xs font-medium text-muted">{label}</div>
          <div className="truncate text-[24px] font-semibold leading-7 tracking-tight text-ink">{value}</div>
        </div>
      </div>
      {sub && <div className="mt-1.5 text-xs leading-snug text-ink-2">{sub}</div>}
      {delta && <div className={`num text-[11px] leading-snug text-muted ${sub ? 'mt-0.5' : 'mt-1.5'}`}>{delta}</div>}
      {trend && <div className="-mx-1 mt-2 h-9" aria-hidden="true">{trend}</div>}
    </div>
  );
}

export function PageHeader({ title, subtitle, eyebrow, children }: { title: ReactNode; subtitle?: ReactNode; eyebrow?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        {eyebrow && <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">{eyebrow}</div>}
        <h1 className="text-[26px] font-semibold leading-8">{title}</h1>
        {subtitle && <p className="mt-1.5 text-sm text-ink-2">{subtitle}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-3">{children}</div>}
    </div>
  );
}

/** Direction pill: a colour dot plus the text label, never colour alone. */
export function Dir({ d }: { d: string }) {
  const isIn = d === 'IN' || d === 'BUY';
  return (
    <span className="pill">
      <span className={`h-1.5 w-1.5 rounded-full ${isIn ? 'bg-s1' : 'bg-s2'}`} />
      {d}
    </span>
  );
}

export function Addr({ a, labels, link = true }: { a: string | null; labels?: Map<string, string>; link?: boolean }) {
  if (!a) return <span className="text-muted">—</span>;
  const label = labels?.get(a);
  const body = (
    <span className="inline-flex items-center gap-1.5" title={a}>
      <span className="rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-xs">{short(a)}</span>
      {label && <span className="rounded-md border border-line px-1.5 py-0.5 text-[11px] font-medium text-ink-2">{label}</span>}
    </span>
  );
  return link ? <Link className="link" href={`/wallet/${a}`}>{body}</Link> : body;
}

export function Tx({ hash, explorer }: { hash: string; explorer: string }) {
  return (
    <a className="link inline-flex items-center gap-1 font-mono text-xs" href={`${explorer}${hash}`} target="_blank" rel="noreferrer" title={`View ${hash} on BscScan`}>
      {hash.slice(0, 10)}… {Icons.external}
    </a>
  );
}

export function Deod({ v, sign }: { v: string | null | undefined; sign?: boolean }) {
  return <span className="num" title={v ?? undefined}>{fmtDeod(v, { sign })}</span>;
}

/** Style for a table cell that shows a magnitude bar behind its number (share of the column maximum). */
export function barStyle(value: string | number | null | undefined, max: number, tone: 's1' | 's2' | 's3' = 's1'): CSSProperties {
  const share = max > 0 ? Math.max(0, Math.min(1, Number(value ?? 0) / max)) : 0;
  return { '--w': `${(share * 100).toFixed(1)}%`, '--bar': `var(--${tone})` } as CSSProperties;
}

export function Note({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-lg border border-line bg-surface/60 px-3 py-2 text-xs leading-relaxed text-ink-2">
      <span className="mt-0.5 text-muted">{Icons.info}</span>
      <span className="min-w-0 break-words">{children}</span>
    </p>
  );
}

export function Empty({ children = 'No activity in this period.' }: { children?: ReactNode }) {
  return <div className="px-4 py-10 text-center text-sm text-muted">{children}</div>;
}

/**
 * Two-part split of a total (IN vs OUT, BUY vs SELL): two bars separated by a 2px gap, with a legend
 * that gives each part's value and share, so the numbers never depend on colour.
 */
export function SplitBar({ a, b, names, format }: { a: number; b: number; names: [string, string]; format: (v: number) => string }) {
  const total = a + b;
  const pa = total > 0 ? (a / total) * 100 : 50;
  const pct = (p: number) => (total > 0 ? `${p.toFixed(p >= 10 ? 0 : 1)}%` : '—');
  return (
    <div>
      <div className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full" role="img" aria-label={`${names[0]} ${pct(pa)}, ${names[1]} ${pct(100 - pa)}`}>
        <div className="rounded-l-full bg-s1" style={{ width: `${pa}%` }} />
        <div className="rounded-r-full bg-s2" style={{ width: `${100 - pa}%` }} />
      </div>
      <div className="mt-2.5 flex justify-between gap-4 text-xs">
        {[[names[0], a, pa, 'bg-s1'], [names[1], b, 100 - pa, 'bg-s2']].map(([n, v, p, c], i) => (
          <div key={String(n)} className={i ? 'text-right' : ''}>
            <div className={`flex items-center gap-1.5 text-muted ${i ? 'justify-end' : ''}`}>
              <span className={`h-2 w-2 rounded-full ${c}`} />{String(n)}
            </div>
            <div className="num mt-0.5 text-sm font-semibold text-ink">{format(Number(v))} <span className="text-xs font-normal text-ink-2">{pct(Number(p))}</span></div>
          </div>
        ))}
      </div>
    </div>
  );
}
