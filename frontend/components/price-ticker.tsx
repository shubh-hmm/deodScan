'use client';

import { useEffect, useState } from 'react';
import { Icons } from '@/components/icons';

export interface PriceData {
  usd: number;
  change24h: number | null;
  volume24h: number | null;
  marketCap: number | null;
  updatedAt: string | null;
  fetchedAt: string;
  stale: boolean;
}

const REFRESH_MS = 30_000;
const COINGECKO_URL = 'https://www.coingecko.com/en/coins/decentrawood';

/** Small prices need more digits than fmtUsd's 2 decimals: $0.01918, not $0.02. */
const price = (v: number) => `$${v.toPrecision(4)}`;

/**
 * Compact dollars, formatted by hand. Intl compact formatting differs between Node and browsers
 * ("$10.8M" vs "$10.80M"), which breaks hydration for a component rendered on both.
 */
function compactUsd(v: number) {
  const units: [number, string][] = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  for (const [size, suffix] of units) {
    if (Math.abs(v) >= size) return `$${(v / size).toFixed(2)}${suffix}`;
  }
  return `$${v.toFixed(2)}`;
}
const utcClock = (iso: string | null) => (iso ? `${iso.slice(11, 19)} UTC` : 'n/a');

export function PriceTicker({ initial }: { initial: PriceData | null }) {
  const [p, setP] = useState<PriceData | null>(initial);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    async function load() {
      if (document.hidden) return;
      try {
        const res = await fetch('/api-price', { cache: 'no-store' });
        if (!res.ok) throw new Error(String(res.status));
        const next = (await res.json()) as PriceData;
        if (alive) { setP(next); setFailed(false); }
      } catch {
        if (alive) setFailed(true);
      }
    }
    if (!initial) void load();
    const timer = setInterval(load, REFRESH_MS);
    const onVisible = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [initial]);

  const delayed = failed || p?.stale;
  const ch = p?.change24h ?? null;
  // Direction is carried by the arrow and sign as well as the colour.
  const chTone = ch === null ? 'text-muted' : ch >= 0 ? 'text-good' : 'text-critical';

  const Metric = ({ icon, label, children, cls = '' }: { icon: React.ReactNode; label: string; children: React.ReactNode; cls?: string }) => (
    <div className={`flex items-center gap-2.5 px-4 py-2 ${cls}`}>
      <span className="badge-icon brand !h-8 !w-8">{icon}</span>
      <div className="leading-tight">
        <div className="text-[11px] text-muted">{label}</div>
        <div className="num text-[15px] font-semibold text-ink">{children}</div>
      </div>
    </div>
  );

  return (
    <div className="flex min-w-0 items-stretch divide-x divide-line overflow-hidden rounded-xl border border-line bg-surface/90 shadow-lg" aria-live="off">
      <Metric icon={Icons.coin} label="DEOD price">
        <span title="DEOD / USD">{p ? price(p.usd) : '—'}</span>
      </Metric>
      <Metric icon={Icons.trend} label="24h change" cls="hidden sm:flex">
        {ch !== null
          ? <span className={chTone} title="Change over the last 24 hours">{ch >= 0 ? '▲' : '▼'} {Math.abs(ch).toFixed(2)}%</span>
          : <span className="text-muted">—</span>}
      </Metric>
      {p?.volume24h != null && <Metric icon={Icons.volume} label="24h volume" cls="hidden lg:flex">{compactUsd(p.volume24h)}</Metric>}
      {p?.marketCap != null && <Metric icon={Icons.pie} label="Market cap" cls="hidden xl:flex">{compactUsd(p.marketCap)}</Metric>}
      <div className="hidden items-center gap-1.5 px-4 text-[11px] text-muted md:flex">
        <span className={`h-1.5 w-1.5 rounded-full ${delayed ? 'bg-warning' : 'live-dot bg-good'}`} />
        <span title={p?.updatedAt ? `CoinGecko updated the price at ${p.updatedAt}` : undefined}>
          {delayed ? <span className="text-warning">Delayed · {utcClock(p?.updatedAt ?? null)}</span> : <>Live · {utcClock(p?.updatedAt ?? null)}</>}
          {' · '}<a className="link" href={COINGECKO_URL} target="_blank" rel="noreferrer">CoinGecko</a>
        </span>
      </div>
    </div>
  );
}
