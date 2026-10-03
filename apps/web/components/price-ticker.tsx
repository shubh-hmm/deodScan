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
    <div className="flex min-w-0 items-center gap-x-4 gap-y-1" aria-live="off">
      <div className="flex items-baseline gap-2">
        <span className="text-xs font-semibold tracking-wide text-ink-2">DEOD</span>
        <span className="num text-lg font-semibold text-ink" title="DEOD / USD">{p ? price(p.usd) : '—'}</span>
        {ch !== null && (
          <span className={`num text-xs font-medium ${chTone}`} title="Change over the last 24 hours">
            {ch >= 0 ? '▲' : '▼'} {Math.abs(ch).toFixed(2)}%
          </span>
        )}
      </div>
      {p?.volume24h != null && (
        <div className="hidden text-xs leading-tight lg:block">
          <div className="text-muted">24h volume</div>
          <div className="num text-ink-2">{compactUsd(p.volume24h)}</div>
        </div>
      )}
      {p?.marketCap != null && (
        <div className="hidden text-xs leading-tight xl:block">
          <div className="text-muted">Market cap</div>
          <div className="num text-ink-2">{compactUsd(p.marketCap)}</div>
        </div>
      )}
      <div className="hidden text-[11px] leading-tight text-muted sm:block">
        <a className="link" href={COINGECKO_URL} target="_blank" rel="noreferrer">CoinGecko</a>
        <div title={p?.updatedAt ? `CoinGecko updated the price at ${p.updatedAt}` : undefined}>
          {delayed
            ? <span className="text-warning">Delayed · last {utcClock(p?.updatedAt ?? null)}</span>
            : <>Live · {utcClock(p?.updatedAt ?? null)}</>}
        </div>
      </div>
    </div>
  );
}
