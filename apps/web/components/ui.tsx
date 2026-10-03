import Link from 'next/link';
import type { ReactNode } from 'react';
import { fmtDeod, short } from '@/lib/format';

export function Card({ title, children, actions, className = '' }: { title?: ReactNode; children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-line bg-surface ${className}`}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-4 border-b border-line px-4 py-2.5">
          <h2 className="text-sm font-medium text-ink">{title}</h2>
          {actions && <div className="flex items-center gap-2 text-xs">{actions}</div>}
        </header>
      )}
      <div>{children}</div>
    </section>
  );
}

export function Stat({ label, value, sub, title, tone }: { label: string; value: ReactNode; sub?: ReactNode; title?: string; tone?: 'in' | 'out' }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3" title={title}>
      <div className="flex items-center gap-2 text-xs text-muted">
        {tone && <span className={`inline-block h-2 w-2 rounded-full ${tone === 'in' ? 'bg-s1' : 'bg-s2'}`} />}
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold text-ink">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-ink-2">{sub}</div>}
    </div>
  );
}

export function PageHeader({ title, subtitle, children }: { title: ReactNode; subtitle?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-ink-2">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

/** Direction badge: colour is paired with the text label, never alone. */
export function Dir({ d }: { d: string }) {
  const isIn = d === 'IN' || d === 'BUY';
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${isIn ? 'text-s1' : 'text-s2'}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${isIn ? 'bg-s1' : 'bg-s2'}`} />
      {d}
    </span>
  );
}

export function Addr({ a, labels, link = true }: { a: string | null; labels?: Map<string, string>; link?: boolean }) {
  if (!a) return <span className="text-muted">—</span>;
  const label = labels?.get(a);
  const body = (
    <span className="font-mono text-xs" title={a}>
      {short(a)}
      {label && <span className="ml-1.5 rounded bg-surface-2 px-1.5 py-0.5 font-sans text-[11px] text-ink-2">{label}</span>}
    </span>
  );
  return link ? <Link className="link" href={`/wallet/${a}`}>{body}</Link> : body;
}

export function Tx({ hash, explorer }: { hash: string; explorer: string }) {
  return (
    <a className="link font-mono text-xs" href={`${explorer}${hash}`} target="_blank" rel="noreferrer" title={`View ${hash} on BscScan`}>
      {hash.slice(0, 10)}…
    </a>
  );
}

export function Deod({ v, sign }: { v: string | null | undefined; sign?: boolean }) {
  return <span className="num" title={v ?? undefined}>{fmtDeod(v, { sign })}</span>;
}

export function Note({ children }: { children: ReactNode }) {
  return <p className="rounded-md border border-line bg-surface-2 px-3 py-2 text-xs text-ink-2">{children}</p>;
}

export function Empty({ children = 'No activity in this period.' }: { children?: ReactNode }) {
  return <div className="px-4 py-8 text-center text-sm text-muted">{children}</div>;
}
