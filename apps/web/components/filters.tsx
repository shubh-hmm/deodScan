import type { ReactNode } from 'react';

/** GET form for combinable filters; keeps the time range. All conditions are ANDed by the API. */
export function FilterForm({ action, params, children }: { action: string; params: Record<string, string | undefined>; children: ReactNode }) {
  return (
    <form action={action} className="flex flex-wrap items-end gap-3 border-b border-line px-4 py-3 text-xs text-ink-2">
      {['range', 'from', 'to'].map((k) => (params[k] ? <input key={k} type="hidden" name={k} value={params[k]} /> : null))}
      {children}
      <button className="rounded-md border border-line bg-surface-2 px-3 py-1.5 text-ink hover:brightness-125">Apply filters</button>
      <a href={`${action}?range=${params.range ?? '24h'}`} className="px-1 py-1.5 text-muted hover:text-ink">Reset</a>
    </form>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="flex flex-col gap-1"><span>{label}</span>{children}</label>;
}

export function Select({ name, value, options }: { name: string; value?: string; options: [string, string][] }) {
  return (
    <select name={name} defaultValue={value ?? ''}>
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
}

export function Pager({ path, params, total, limit }: { path: string; params: Record<string, string | undefined>; total: number; limit: number }) {
  const offset = Number(params.offset ?? 0);
  const href = (o: number) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]);
    q.set('offset', String(o));
    return `${path}?${q}`;
  };
  return (
    <div className="flex items-center justify-between px-4 py-2.5 text-xs text-ink-2">
      <span className="num">{total ? `${offset + 1}–${Math.min(offset + limit, total)} of ${total.toLocaleString('en-US')}` : '0 results'}</span>
      <span className="flex gap-3">
        {offset > 0 && <a className="link" href={href(Math.max(0, offset - limit))}>← Newer</a>}
        {offset + limit < total && <a className="link" href={href(offset + limit)}>Older →</a>}
      </span>
    </div>
  );
}
