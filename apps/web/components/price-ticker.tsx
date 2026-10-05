'use client';

import { useEffect, useState } from 'react';

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

  return (
    <div className="flex min-w-0 items-center gap-x-5 gap-y-1" aria-live="off">
      <div className="flex items-center gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-3 text-[10px] font-bold tracking-wide text-ink-2">DEOD</div>
        <div className="leading-tight">
          <div className="flex items-baseline gap-2">
            <span className="num text-xl font-semibold tracking-tight text-ink" title="DEOD / USD">{p ? price(p.usd) : '—'}</span>
            {ch !== null && (
              <span className={`num rounded-md bg-surface-2 px-1.5 py-0.5 text-xs font-semibold ${chTone}`} title="Change over the last 24 hours">
                {ch >= 0 ? '▲' : '▼'} {Math.abs(ch).toFixed(2)}%
              </span>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted">
            <span className={`h-1.5 w-1.5 rounded-full ${delayed ? 'bg-warning' : 'live-dot bg-good'}`} />
            <span title={p?.updatedAt ? `CoinGecko updated the price at ${p.updatedAt}` : undefined}>
              {delayed ? <span className="text-warning">Delayed · last {utcClock(p?.updatedAt ?? null)}</span> : <>Live · {utcClock(p?.updatedAt ?? null)}</>}
            </span>
          </div>
        </div>
      </div>
      {p?.volume24h != null && (
        <div className="hidden border-l border-line pl-5 text-xs leading-tight lg:block">
          <div className="text-muted">24h volume</div>
          <div className="num mt-0.5 text-sm font-medium text-ink">{compactUsd(p.volume24h)}</div>
        </div>
      )}
      {p?.marketCap != null && (
        <div className="hidden border-l border-line pl-5 text-xs leading-tight xl:block">
          <div className="text-muted">Market cap</div>
          <div className="num mt-0.5 text-sm font-medium text-ink">{compactUsd(p.marketCap)}</div>
        </div>
      )}
      <a className="link hidden border-l border-line pl-5 text-[11px] sm:block" href={COINGECKO_URL} target="_blank" rel="noreferrer">
        Price by CoinGecko
      </a>
    </div>
  );
}
