import Link from 'next/link';
import { api, clean, flat, labelMap, meta, type SearchParams } from '@/lib/api';
import { fmtDeod, fmtInt, fmtPrice, fmtTime, fmtUsd } from '@/lib/format';
import { pairSeries } from '@/lib/series';
import { Addr, Card, Deod, Dir, Empty, Note, PageHeader, Stat, Tx } from '@/components/ui';
import { PairBars } from '@/components/charts';
import { RangePicker, rangeParams, windowLabel } from '@/components/range';
import { SwapTable } from '@/components/swap-table';

const VERSIONS = [['all', 'Combined'], ['2', 'V2'], ['3', 'V3']] as const;

function TopTable({ rows, labels, side }: { rows: any[]; labels: Map<string, string>; side: 'buy' | 'sell' }) {
  const rowsWithSide = rows.filter((w) => Number(side === 'buy' ? w.swap_buy : w.swap_sell) > 0);
  if (!rowsWithSide.length) return <Empty />;
  return (
    <div className="overflow-x-auto">
      <table className="data">
        <thead><tr><th>#</th><th>Trader (tx signer)</th><th className="r">{side === 'buy' ? 'Bought' : 'Sold'} DEOD</th><th className="r">All swaps</th><th className="r">Largest swap</th><th>Last swap</th></tr></thead>
        <tbody>
          {rowsWithSide.map((w, i) => (
            <tr key={w.wallet_address}>
              <td className="text-muted">{i + 1}</td>
              <td><Addr a={w.wallet_address} labels={labels} /></td>
              <td className="r"><Deod v={side === 'buy' ? w.swap_buy : w.swap_sell} /></td>
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
      <PageHeader title="PancakeSwap" subtitle={`${windowLabel(d.window)} · DEOD swaps in monitored pools`}>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex overflow-hidden rounded-md border border-line text-xs">
            {VERSIONS.map(([v, label]) => (
              <Link key={v} href={vHref(v)} className={`px-3 py-1.5 ${version === v ? 'bg-surface-2 font-semibold' : 'text-ink-2 hover:bg-surface-2'}`}>{label}</Link>
            ))}
          </div>
          <RangePicker path="/PancakeSwap" params={{ ...p, version }} />
        </div>
      </PageHeader>

      <div className="mb-4 space-y-2">
        {pools.map((pl) => (
          <Note key={pl.address}>
            V{pl.version} pool <span className="font-mono">{pl.address}</span> · {pl.pair}{pl.fee_tier ? ` · fee ${pl.fee_tier / 10000}%` : ''} · {pl.verification}
          </Note>
        ))}
        <Note>{m.traderNote} USD values use USDT = $1 (the pools&apos; quote token).</Note>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        <Stat label="DEOD volume" value={fmtDeod(s.deod_volume)} sub={fmtUsd(s.usd_volume, true)} title={`${s.deod_volume} DEOD`} />
        <Stat label="Buy volume" tone="in" value={fmtDeod(s.buy_deod)} sub={`${fmtUsd(s.buy_usd, true)} · ${fmtInt(s.buys)} buys`} />
        <Stat label="Sell volume" tone="out" value={fmtDeod(s.sell_deod)} sub={`${fmtUsd(s.sell_usd, true)} · ${fmtInt(s.sells)} sells`} />
        <Stat label="Swaps" value={fmtInt(s.swaps)} />
        <Stat label="Unique traders" value={fmtInt(s.unique_wallets)} sub="Distinct tx signers" />
        <Stat label="Last price" value={fmtPrice(s.last_price)} sub={`Largest swap ${fmtDeod(s.largest_swap_deod)} DEOD`} />
      </div>

      <Card title={`Historical volume (DEOD) · per ${d.window.bucket}`} className="mt-4">
        <div className="px-2 pt-2"><PairBars data={chart} bucket={d.window.bucket} names={['BUY', 'SELL', 'Net bought']} /></div>
      </Card>

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
