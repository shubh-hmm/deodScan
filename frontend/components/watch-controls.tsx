'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

async function call(method: 'POST' | 'DELETE', body?: unknown, address?: string): Promise<string | null> {
  try {
    const res = await fetch(method === 'DELETE' ? `/api-watch?address=${address}` : '/api-watch', {
      method, cache: 'no-store', ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    if (res.ok) return null;
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    return j.error ?? `Failed (${res.status})`;
  } catch {
    return 'No answer from the server';
  }
}

/** Watch / stop watching one wallet (used on the wallet page). Watches incoming and outgoing recorded transfers. */
export function WatchToggle({ address, watched }: { address: string; watched: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    setBusy(true); setError(null);
    const err = watched ? await call('DELETE', undefined, address) : await call('POST', { address, watch: 'both' });
    setBusy(false);
    if (err) setError(err); else router.refresh();
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <button type="button" className={watched ? 'chip cursor-pointer hover:border-line-strong' : 'btn'} onClick={() => void toggle()} disabled={busy}
        title="Alerts for recorded transfers and swaps of this wallet. Does not see other wallet transfers.">
        {busy ? 'Saving…' : watched ? '✓ Watching · Stop' : 'Watch this wallet'}
      </button>
      {error ? <span role="alert" className="text-xs text-[#ff9b73]">{error}</span> : null}
    </div>
  );
}

/** Add a wallet to the watchlist (Alerts page). */
export function WatchForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setBusy(true); setError(null);
    const err = await call('POST', {
      address: String(f.get('address') ?? '').trim(), label: String(f.get('label') ?? '').trim() || undefined,
      watch: String(f.get('watch') ?? 'both'), min_amount: Number(f.get('min_amount') || 0),
    });
    setBusy(false);
    if (err) { setError(err); return; }
    form.reset(); router.refresh();
  }
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-wrap items-end gap-3 border-b border-line bg-surface-2/30 px-4 py-3.5 text-xs text-ink-2">
      <label className="flex min-w-[22rem] flex-1 flex-col gap-1.5"><span className="text-[11px] font-medium text-muted">Wallet address</span>
        <input name="address" required placeholder="0x…" pattern="0x[0-9a-fA-F]{40}" className="font-mono" /></label>
      <label className="flex flex-col gap-1.5"><span className="text-[11px] font-medium text-muted">Label (optional)</span>
        <input name="label" maxLength={60} placeholder="e.g. Market maker" /></label>
      <label className="flex flex-col gap-1.5"><span className="text-[11px] font-medium text-muted">Alert on</span>
        <select name="watch" defaultValue="both"><option value="both">Incoming and outgoing</option><option value="incoming">Incoming only (wallet received)</option><option value="outgoing">Outgoing only (wallet sent)</option></select></label>
      <label className="flex flex-col gap-1.5"><span className="text-[11px] font-medium text-muted">Min. DEOD</span>
        <input name="min_amount" type="number" min="0" step="any" defaultValue="0" className="w-28" /></label>
      <button className="btn" disabled={busy}>{busy ? 'Adding…' : 'Watch wallet'}</button>
      {error ? <span role="alert" className="basis-full text-[#ff9b73]">{error}</span> : null}
    </form>
  );
}

export function RemoveWatch({ address }: { address: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button type="button" className="link text-xs" disabled={busy} onClick={async () => { setBusy(true); await call('DELETE', undefined, address); setBusy(false); router.refresh(); }}>
      {busy ? '…' : 'Remove'}
    </button>
  );
}
