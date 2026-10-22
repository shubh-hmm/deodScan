'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { SummaryCard, type SummaryData } from '@/components/summary-card';

/**
 * "Show summary" button. The summary is closed when the page opens and is fetched only when the person clicks, for the period the page is showing.
 * Changing the period closes it again (the old text would no longer match the page).
 */
export function SummaryToggle({ range, from, to }: { range: string; from?: string; to?: string }) {
  const key = `${range}|${from ?? ''}|${to ?? ''}`;
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<{ key: string; data?: SummaryData; error?: string }>({ key: '' });
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  useEffect(() => { setOpen(false); setLoading(false); seq.current++; }, [key]);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const q = new URLSearchParams({ range });
      if (from) q.set('from', from);
      if (to) q.set('to', to);
      const res = await fetch(`/api-summary?${q}`, { cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? 'The summary could not be loaded.');
      if (mine === seq.current) setState({ key, data: body as SummaryData });
    } catch (e) {
      if (mine === seq.current) setState({ key, error: e instanceof Error ? e.message : 'The summary could not be loaded.' });
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [range, from, to, key]);

  const toggle = () => {
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (state.key !== key || !state.data) void load();
  };

  const current = state.key === key ? state : { key };
  return (
    <div className="mb-4">
      {/* Highlighted while closed (the same violet as the other main buttons) so it is easy to find; a quiet outline once the summary is open. */}
      <button
        type="button" onClick={toggle} aria-expanded={open} aria-controls="dashboard-summary"
        className={open ? 'chip cursor-pointer !border-accent/50 hover:!border-accent' : 'btn inline-flex cursor-pointer items-center gap-2 !px-4 !py-2 text-sm font-semibold shadow-[0_0_0_3px_rgba(139,108,255,0.18)]'}
      >
        <span aria-hidden="true" className={`inline-block transition-transform ${open ? 'rotate-90' : ''}`}>▸</span>
        <span>{open ? 'Hide summary' : 'Show summary'}</span>
      </button>
      {open && (
        <div id="dashboard-summary" className="mt-3">
          {loading && !current.data ? <p className="flex items-center gap-2 px-1 text-sm text-muted"><span className="spinner" aria-hidden="true" />Writing the summary from your data…</p> : null}
          {current.error && !loading ? (
            <p role="alert" className="rounded-xl border border-line bg-surface px-4 py-3 text-sm text-[#ff9b73]">
              {current.error} <button type="button" className="link ml-1" onClick={() => void load()}>Try again</button>
            </p>
          ) : null}
          {current.data ? <SummaryCard s={current.data} /> : null}
        </div>
      )}
    </div>
  );
}
