import Link from 'next/link';
import { api, clean, flat, labelMap, meta, type SearchParams } from '@/lib/api';
import { fmtDeod, fmtInt, fmtPrice, fmtTime, fmtUsd } from '@/lib/format';
import { pairSeries } from '@/lib/series';
import { Addr, barStyle, Card, Deod, Empty, Note, PageHeader, SplitBar, Stat } from '@/components/ui';
import { PairBars } from '@/components/charts';
import { Icons } from '@/components/icons';
import { RangePicker, rangeParams, windowLabel } from '@/components/range';
import { SwapTable } from '@/components/swap-table';

const VERSIONS = [['all', 'Combined'], ['2', 'V2'], ['3', 'V3']] as const;

function TopTable({ rows, labels, side }: { rows: any[]; labels: Map<string, string>; side: 'buy' | 'sell' }) {
  const rowsWithSide = rows.filter((w) => Number(side === 'buy' ? w.swap_buy : w.swap_sell) > 0);
  if (!rowsWithSide.length) return <Empty />;
  const val = (w: any) => (side === 'buy' ? w.swap_buy : w.swap_sell);
  const max = Math.max(0, ...rowsWithSide.map((w) => Number(val(w))));
  return (
    <div className="overflow-x-auto">
      <table className="data">
        <thead><tr><th>#</th><th>Trader (tx signer)</th><th className="r">{side === 'buy' ? 'Bought' : 'Sold'} DEOD</th><th className="r">All swaps</th><th className="r">Largest swap</th><th>Last swap</th></tr></thead>
        <tbody>
          {rowsWithSide.map((w, i) => (
            <tr key={w.wallet_address}>
              <td className="text-muted">{i + 1}</td>
              <td><Addr a={w.wallet_address} labels={labels} /></td>
              <td className="r bar-cell" style={barStyle(val(w), max, side === 'buy' ? 's1' : 's2')}><Deod v={val(w)} /></td>
              <td className="r num">{fmtInt(w.transactions)}</td>
              <td className="r"><Deod v={w.largest} /></td>
              <td className="num text-ink-2">{fmtTime(w.last_seen)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function PancakePage({ searchParams }: { searchParams: SearchParams }) {
  const p = await flat(searchParams);
  const r = rangeParams(p);
  const version = (['2', '3'].includes(p.version ?? '') ? p.version : 'all') as '2' | '3' | 'all';
  const [m, d, recent] = await Promise.all([
    meta(),
    api('/api/pancakeswap', { ...r, version }),
    api('/api/swaps', { ...r, version, limit: '25' }),
  ]);
  const labels = labelMap(m);
  const s = d.stats;
  const chart = pairSeries(d.series, d.window, (x: any) => Number(x.buy_deod), (x: any) => Number(x.sell_deod));
  const pools = m.pools.filter((pl) => version === 'all' || pl.version === version);
  const vHref = (v: string) => `/PancakeSwap?${new URLSearchParams({ ...clean(r), version: v })}`;

  return (
    <>
      <PageHeader eyebrow="DEX" title="PancakeSwap" subtitle={`${windowLabel(d.window)} · DEOD swaps in monitored pools`}>
        <div className="flex flex-wrap items-center gap-3">
          <div className="seg" role="group" aria-label="Pool version">
            {VERSIONS.map(([v, label]) => (
              <Link key={v} href={vHref(v)} aria-current={version === v ? 'true' : undefined}>{label}</Link>
            ))}
          </div>
          <RangePicker path="/PancakeSwap" params={{ ...p, version }} />
        </div>
      </PageHeader>

      <Card title="Monitored pools" className="mb-4">
        <ul>
          {pools.map((pl) => (
            <li key={pl.address} className="border-b border-line px-4 py-3 last:border-b-0">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <span className="badge-icon brand !h-8 !w-8 text-[11px] font-bold">V{pl.version}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                    PancakeSwap V{pl.version} · {pl.pair}
                    {pl.fee_tier ? <span className="pill">fee {pl.fee_tier / 10000}%</span> : null}
                    <span className="pill">Verified on-chain</span>
                  </div>
                  <div className="mt-0.5 font-mono text-xs text-muted" title={pl.address}>{pl.address}</div>
                </div>
                <a className="link inline-flex items-center gap-1 text-xs" href={`${m.chain.explorer_address_url}${pl.address}`} target="_blank" rel="noreferrer">
                  View on BscScan {Icons.external}
                </a>
              </div>
              {pl.verification && (
                <details className="mt-2 text-xs text-ink-2">
                  <summary className="cursor-pointer select-none text-muted hover:text-ink">How this was verified</summary>
                  <p className="mt-1.5 rounded-lg bg-surface-2/60 px-3 py-2 leading-relaxed">{pl.verification}</p>
                </details>
              )}
            </li>
          ))}
        </ul>
        <div className="border-t border-line p-3">
          <Note>{m.traderNote} USD values use USDT = $1 (the pools&apos; quote token).</Note>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        <Stat icon={Icons.volume} label="DEOD volume" value={fmtDeod(s.deod_volume)} sub={fmtUsd(s.usd_volume, true)} title={`${s.deod_volume} DEOD`} />
        <Stat icon={Icons.down} label="Buy volume" tone="in" value={fmtDeod(s.buy_deod)} sub={`${fmtUsd(s.buy_usd, true)} · ${fmtInt(s.buys)} buys`} />
        <Stat icon={Icons.up} label="Sell volume" tone="out" value={fmtDeod(s.sell_deod)} sub={`${fmtUsd(s.sell_usd, true)} · ${fmtInt(s.sells)} sells`} />
        <Stat icon={Icons.swap} label="Swaps" value={fmtInt(s.swaps)} />
        <Stat icon={Icons.wallets} label="Unique traders" value={fmtInt(s.unique_wallets)} sub="Distinct tx signers" />
        <Stat icon={Icons.coin} label="Last price" value={fmtPrice(s.last_price)} sub={`Largest swap ${fmtDeod(s.largest_swap_deod)} DEOD`} />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-5">
        <Card title="Buy / sell split (DEOD)" className="xl:col-span-2">
          <div className="p-5">
            <SplitBar a={Number(s.buy_deod)} b={Number(s.sell_deod)} names={['Buy volume', 'Sell volume']} format={(v) => `${fmtDeod(v)} DEOD`} />
            <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 border-t border-line pt-4 text-sm">
              <div><dt className="text-xs text-muted">Buys</dt><dd className="num">{fmtInt(s.buys)}</dd></div>
              <div><dt className="text-xs text-muted">Sells</dt><dd className="num">{fmtInt(s.sells)}</dd></div>
            </dl>
          </div>
        </Card>
        <Card title={`Historical volume (DEOD) · per ${d.window.bucket}`} className="xl:col-span-3">
          <div className="px-2 pt-2"><PairBars data={chart} bucket={d.window.bucket} names={['BUY', 'SELL', 'Net bought']} /></div>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card title="Top buyers"><TopTable rows={d.topBuyers} labels={labels} side="buy" /></Card>
        <Card title="Top sellers"><TopTable rows={d.topSellers} labels={labels} side="sell" /></Card>
      </div>

      <Card title="Recent swaps" className="mt-4"
        actions={<>
          <Link className="link" href={`/swaps?${new URLSearchParams({ ...clean(r), version })}`}>Filter & browse →</Link>
          <Link className="link" href={`/api-export/swaps?${new URLSearchParams({ ...clean(r), version })}`}>CSV</Link>
        </>}>
        <SwapTable rows={recent.rows} labels={labels} explorer={m.chain.explorer_tx_url} />
      </Card>
    </>
  );
}
