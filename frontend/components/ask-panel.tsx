'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icons } from '@/components/icons';

interface ToolRecord { tool: string; args: Record<string, unknown>; result: any; error?: string }
interface Answer { answer: string; verified: boolean; unverified: string[]; data: ToolRecord[]; model: string; remainingToday: number }
interface Status { enabled: boolean; reason: string | null; model: string | null; maxQuestionChars: number; usage: { remaining: number; limit: number } | null }
type Turn = { id: number; question: string; state: 'loading' | 'done' | 'error'; answer?: Answer; error?: string };

const SUGGESTIONS = [
  'How much did exchanges receive and pay out in the last 7 days?',
  'Which exchange had the largest withdrawal this month?',
  'Show the 5 largest PancakeSwap swaps this week.',
  'What does the data not cover yet?',
];

const short = (v: string) => (/^0x[0-9a-fA-F]{40,64}$/.test(v) ? `${v.slice(0, 8)}…${v.slice(-6)}` : v);
const cell = (key: string, v: unknown): React.ReactNode => {
  if (v === null || v === undefined || v === '') return '—';
  if (key === 'explorer_url' && typeof v === 'string') return <a className="link" href={v} target="_blank" rel="noreferrer">view tx</a>;
  if (typeof v === 'string' && /^-?\d+\.\d{6,}$/.test(v)) return Number(v).toLocaleString('en-US', { maximumFractionDigits: 4 });
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return v.slice(0, 16).replace('T', ' ');
  if (typeof v === 'object') return JSON.stringify(v);
  return short(String(v));
};

/** The rows (transfers, swaps, wallets, alerts, exchanges) inside a tool result, if it has any. */
function rowsOf(result: any): Record<string, unknown>[] | null {
  if (!result || typeof result !== 'object') return null;
  for (const k of ['transfers', 'swaps', 'wallets', 'alerts', 'exchanges', 'recent_activity']) if (Array.isArray(result[k]) && result[k].length && typeof result[k][0] === 'object') return result[k];
  return null;
}

function Data({ r }: { r: ToolRecord }) {
  const rows = rowsOf(r.result);
  const cols = rows ? Object.keys(rows[0]!).filter((k) => !['exchange_address', 'tx_hash'].includes(k)).slice(0, 7) : [];
  const args = Object.entries(r.args ?? {}).map(([k, v]) => `${k}=${String(v)}`).join(', ');
  return (
    <div className="rounded-lg border border-line bg-surface-2/40 p-2.5">
      <div className="font-mono text-[11px] text-ink-2">{r.tool}{args ? ` (${args})` : ''}</div>
      {r.error ? <p className="mt-1 text-xs text-[#ff9b73]">{r.error}</p> : rows ? (
        <div className="mt-2 overflow-x-auto">
          <table className="data !text-[11px]">
            <thead><tr>{cols.map((c) => <th key={c}>{c.replaceAll('_', ' ')}</th>)}</tr></thead>
            <tbody>{rows.slice(0, 25).map((row, i) => <tr key={i}>{cols.map((c) => <td key={c} className="num">{cell(c, row[c])}</td>)}</tr>)}</tbody>
          </table>
        </div>
      ) : <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[11px] text-ink-2">{JSON.stringify(r.result, null, 1)}</pre>}
    </div>
  );
}

/** The "Ask AI" button in the top bar and the chat panel it opens. Questions go to OpenAI through the backend; the key never reaches the browser. */
export function AskPanel() {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [status, setStatus] = useState<Status | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const busy = turns.some((t) => t.state === 'loading');

  useEffect(() => {
    if (!open) return;
    box.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    if (!status) fetch('/api-ask', { cache: 'no-store' }).then((r) => r.json()).then(setStatus).catch(() => setStatus({ enabled: false, reason: 'The backend is not answering. Start it and try again.', model: null, maxQuestionChars: 500, usage: null }));
    return () => window.removeEventListener('keydown', onKey);
  }, [open, status]);

  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [turns]);

  const send = useCallback(async (q: string) => {
    const question = q.trim();
    if (!question || busy) return;
    const id = Date.now();
    setText('');
    setTurns((t) => [...t, { id, question, state: 'loading' }]);
    try {
      const res = await fetch('/api-ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `Something went wrong (${res.status}).`);
      setTurns((t) => t.map((x) => (x.id === id ? { ...x, state: 'done', answer: body as Answer } : x)));
      setStatus((s) => (s && s.usage ? { ...s, usage: { ...s.usage, remaining: (body as Answer).remainingToday } } : s));
    } catch (e) {
      setTurns((t) => t.map((x) => (x.id === id ? { ...x, state: 'error', error: e instanceof Error ? e.message : 'Something went wrong.' } : x)));
    }
  }, [busy]);

  return (
    <>
      <button type="button" className="chip cursor-pointer !border-accent/40 text-ink hover:!border-accent" onClick={() => setOpen(true)} title="Ask questions about the DEOD data in plain language">
        <span className="text-accent">{Icons.sparkle}</span><span>Ask AI</span>
      </button>

      {/* Drawn on <body>, not inside the top bar: the bar's blur effect would make "fixed" mean "inside the bar" and squeeze the panel. */}
      {open && mounted && createPortal(
        <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
          <aside role="dialog" aria-label="Ask DEODScan AI" className="flex h-full w-full max-w-[460px] flex-col border-l border-line-strong bg-sidebar shadow-2xl">
            <header className="flex items-center justify-between border-b border-line px-4 py-3">
              <div className="flex items-center gap-2"><span className="text-accent">{Icons.sparkle}</span><h2 className="text-sm font-semibold">Ask DEODScan AI</h2></div>
              <button type="button" className="rounded-md px-2 py-1 text-muted hover:bg-white/5 hover:text-ink" onClick={() => setOpen(false)} aria-label="Close">✕</button>
            </header>

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 text-sm">
              {status && !status.enabled ? (
                <div className="rounded-xl border border-line bg-surface p-4">
                  <p className="font-medium">The AI assistant is not switched on.</p>
                  <p className="mt-1.5 text-ink-2">{status.reason}</p>
                </div>
              ) : !turns.length ? (
                <div>
                  <p className="text-ink-2">Ask about DEOD flows, exchanges, swaps, wallets or alerts. Every figure in an answer is looked up in your data and checked before it is shown.</p>
                  <div className="mt-3 space-y-2">
                    {SUGGESTIONS.map((s) => <button key={s} type="button" disabled={!status?.enabled} onClick={() => void send(s)} className="block w-full rounded-lg border border-line bg-surface px-3 py-2 text-left text-ink-2 hover:border-line-strong hover:text-ink disabled:opacity-50">{s}</button>)}
                  </div>
                </div>
              ) : null}

              {turns.map((t) => (
                <div key={t.id} className="space-y-2">
                  <div className="ml-8 rounded-xl bg-accent/15 px-3 py-2 text-ink">{t.question}</div>
                  {t.state === 'loading' && <p className="flex items-center gap-2 text-muted"><span className="spinner" aria-hidden="true" />Looking up your data…</p>}
                  {t.state === 'error' && <p role="alert" className="rounded-xl border border-line bg-surface px-3 py-2 text-[#ff9b73]">{t.error}</p>}
                  {t.state === 'done' && t.answer && (
                    <div className="rounded-xl border border-line bg-surface px-3 py-2.5">
                      <p className="whitespace-pre-wrap leading-relaxed text-ink">{t.answer.answer}</p>
                      <p className={`mt-2 text-[11px] ${t.answer.verified ? 'text-muted' : 'text-warning'}`}>
                        {t.answer.verified ? '✓ Every figure was checked against your data.' : `⚠ Not shown: ${t.answer.unverified.join(', ')} could not be matched to your data.`}
                      </p>
                      {t.answer.data.length > 0 && (
                        <details className="mt-2">
                          <summary className="cursor-pointer text-xs text-ink-2 hover:text-ink">Supporting data ({t.answer.data.length})</summary>
                          <div className="mt-2 space-y-2">{t.answer.data.map((d, i) => <Data key={i} r={d} />)}</div>
                        </details>
                      )}
                    </div>
                  )}
                </div>
              ))}
              <div ref={end} />
            </div>

            <footer className="border-t border-line p-3">
              <form onSubmit={(e) => { e.preventDefault(); void send(text); }} className="flex items-end gap-2">
                <textarea
                  ref={box} value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={status?.maxQuestionChars ?? 500}
                  disabled={status ? !status.enabled : false} placeholder="Ask a question about the DEOD data…" aria-label="Your question"
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(text); } }}
                  className="min-h-[2.75rem] flex-1 resize-none !rounded-xl !border-line-strong !bg-surface/90 !py-2 text-sm"
                />
                <button className="btn" disabled={busy || !text.trim() || (status ? !status.enabled : false)}>Ask</button>
              </form>
              <p className="mt-2 text-[10.5px] leading-snug text-muted">
                Answers use only recorded data (see the notes on each page) and can still be incomplete or misread: check the supporting data. Your question and the data it needs are sent to OpenAI.
                {status?.usage ? ` ${status.usage.remaining} of ${status.usage.limit} questions left today.` : ''}
              </p>
            </footer>
          </aside>
        </div>,
        document.body,
      )}
    </>
  );
}
