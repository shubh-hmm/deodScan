'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Icons } from '@/components/icons';

interface Job { state: 'idle' | 'running' | 'done' | 'error'; result?: { inserted: number; credits: number }; error?: string }
interface Usage { used: number; max: number; remaining: number }
interface Auto { enabled: boolean; timesUtc: string[] }
interface Status { enabled: boolean; cooldownSeconds: number; usage?: Usage; auto?: Auto; job: Job }

type Phase = 'idle' | 'confirm' | 'running' | 'done' | 'error';

const POLL_MS = 3000;

/**
 * "Update today": fetches the unfinished current UTC day on demand. It costs Dune credits, so it asks first, and the server allows
 * it only a limited number of times per UTC day (default 2) and not twice within a few minutes. The button shows how many uses are left.
 * While it runs the button polls; when it finishes the page data is reloaded.
 */
export function RefreshToday() {
  const router = useRouter();
  const [enabled, setEnabled] = useState(true);
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState('');
  const [usage, setUsage] = useState<Usage | null>(null);
  const [auto, setAuto] = useState<Auto | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const status = useCallback(async (): Promise<Status | null> => {
    try {
      const res = await fetch('/api-refresh', { cache: 'no-store' });
      return res.ok ? ((await res.json()) as Status) : null;
    } catch { return null; }
  }, []);

  const poll = useCallback(async () => {
    const s = await status();
    if (s?.usage) setUsage(s.usage);
    if (s?.job.state === 'running') { timer.current = setTimeout(poll, POLL_MS); return; }
    if (s?.job.state === 'done') {
      setPhase('done');
      setMessage(`${s.job.result?.inserted ?? 0} new · ${(s.job.result?.credits ?? 0).toFixed(2)} credits`);
      router.refresh();
      timer.current = setTimeout(() => setPhase('idle'), 8000);
    } else {
      setPhase('error');
      setMessage(s?.job.error ?? 'No answer from the backend');
      timer.current = setTimeout(() => setPhase('idle'), 10000);
    }
  }, [router, status]);

  useEffect(() => {
    let alive = true;
    void status().then((s) => {
      if (!alive || !s) return;
      setEnabled(s.enabled);
      if (s.usage) setUsage(s.usage);
      if (s.auto) setAuto(s.auto);
      if (s.job.state === 'running') { setPhase('running'); void poll(); }
    });
    return () => { alive = false; if (timer.current) clearTimeout(timer.current); };
  }, [poll, status]);

  async function start() {
    setPhase('running'); setMessage('');
    try {
      const res = await fetch('/api-refresh', { method: 'POST', cache: 'no-store' });
      if (res.status === 202 || res.status === 409) { timer.current = setTimeout(poll, POLL_MS); return; }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setPhase('error'); setMessage(body.error ?? `Failed (${res.status})`);
      void status().then((s) => { if (s?.usage) setUsage(s.usage); });
      timer.current = setTimeout(() => setPhase('idle'), 10000);
    } catch {
      setPhase('error'); setMessage('No answer from the backend');
    }
  }

  if (!enabled) return null;
  // The worker's scheduled times are in UTC; show them in the viewer's own time so nobody has to convert.
  const autoText = auto?.enabled && auto.timesUtc.length
    ? ` The worker also updates by itself at ${auto.timesUtc.map((t) => { const [h, m] = t.split(':').map(Number); return new Date(Date.UTC(2026, 0, 1, h, m)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }).join(' and ')} your time (${auto.timesUtc.join(' and ')} UTC), in addition to your ${usage?.max ?? 2} button updates a day.`
    : '';
  const limitReached = !!usage && usage.remaining <= 0;

  if (phase === 'confirm') {
    return (
      <div className="chip" role="alertdialog" aria-label="Confirm update">
        <span>Fetch today so far? Uses about 0.5–1 Dune credit{usage ? `; ${usage.remaining} of ${usage.max} uses left today` : ''}.</span>
        <button type="button" className="btn !px-2.5 !py-1 text-xs" onClick={() => void start()}>Fetch</button>
        <button type="button" className="link text-xs" onClick={() => setPhase('idle')}>Cancel</button>
      </div>
    );
  }
  return (
    <button
      type="button"
      className="chip cursor-pointer hover:border-line-strong disabled:cursor-wait"
      disabled={phase === 'running' || limitReached}
      onClick={() => setPhase('confirm')}
      title={limitReached
        ? `Used ${usage!.max} of ${usage!.max} button updates today. It resets at 00:00 UTC. Finished days are still synced automatically.${autoText}`
        : `Fetch today's unfinished UTC day from Dune (finished days are synced automatically by the worker).${usage ? ` ${usage.remaining} of ${usage.max} updates left today.` : ''}${autoText}`}
    >
      <span className={phase === 'running' ? 'animate-spin' : ''}>{Icons.refresh}</span>
      <span aria-live="polite">
        {phase === 'running' ? 'Fetching today…' : phase === 'done' ? `Updated · ${message}` : phase === 'error' ? message : limitReached ? 'Update today · limit reached' : usage ? `Update today · ${usage.remaining} left` : 'Update today'}
      </span>
    </button>
  );
}
