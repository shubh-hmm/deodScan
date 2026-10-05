import Link from 'next/link';
import { api, flat, labelMap, meta, type SearchParams } from '@/lib/api';
import { fmtDeod, fmtInt, fmtPrice, fmtTime, fmtUsd } from '@/lib/format';
import { pairSeries, withCumulative } from '@/lib/series';
import { Addr, barStyle, Card, Deod, Dir, Empty, Note, PageHeader, SplitBar, Stat, Tx } from '@/components/ui';
import { CumulativeArea, PairBars, SERIES, Sparkline } from '@/components/charts';
import { FlowBars } from '@/components/flow-bars';
import { RangePicker, rangeParams, windowLabel } from '@/components/range';

export const dynamic = 'force-dynamic';

export default async function Dashboard({ searchParams }: { searchParams: SearchParams }) {
  const p = await flat(searchParams);
  const r = rangeParams(p);
  const [m, ov, series, recent] = await Promise.all([
    meta(),
    api('/api/overview', r),
    api('/api/flows/series', r),
    api('/api/flows', { ...r, limit: '12' }),
  ]);
  const labels = labelMap(m);
  const t = ov.totals;
  const ps = ov.pancakeswap;
  const chart = pairSeries(series.rows, series.window, (x: any) => Number(x.inflow), (x: any) => Number(x.outflow));
  const cum = withCumulative(chart);
  const bucket = series.window.bucket as 'hour' | 'day';
  const maxRecent = Math.max(0, ...recent.rows.map((f: any) => Number(f.amount)));
  const money = (v: number) => `${fmtDeod(v)} DEOD`;

  return (
    <>
      <PageHeader eyebrow="Overview" title="DEOD On-Chain Monitor"
        subtitle={`${windowLabel(ov.window)} · BNB Chain · Data through ${m.dataThrough ? `${fmtTime(m.dataThrough)} UTC` : 'n/a'}`}>
        <RangePicker path="/" params={p} />
      </PageHeader>

      <div className="mb-4"><Note>{m.freshnessNote}</Note></div>

      {/* Hero: the one headline figure, with the IN/OUT split behind it and the running total over time */}
      <Card className="mb-4">
        <div className="grid gap-0 xl:grid-cols-5">
          <div className="flex flex-col justify-between gap-6 p-5 xl:col-span-2 xl:border-r xl:border-line">
            <div>
              <div className="text-xs font-medium text-muted">Net exchange flow · {windowLabel(ov.window).toLowerCase()}</div>
              <div className="hero-figure mt-2 text-[56px] font-semibold leading-none text-ink" title={`${t.net} DEOD`}>
                {fmtDeod(t.net, { sign: true })}
                <span className="ml-2 text-lg font-medium text-ink-2">DEOD</span>
              </div>
              <div className="mt-3 text-sm text-ink-2">Inflow − outflow across MEXC, BitMart and Toobit. A factual difference, not a signal.</div>
            </div>
            <SplitBar a={Number(t.inflow)} b={Number(t.outflow)} names={['Inflow', 'Outflow']} format={money} />
          </div>
          <div className="min-w-0 p-4 xl:col-span-3">
            <div className="mb-1 flex items-center justify-between px-1">
              <h2 className="text-[13px] font-semibold tracking-wide">Cumulative net flow</h2>
              <span className="text-xs text-muted">running total, per {bucket}</span>
            </div>
            <CumulativeArea data={cum} bucket={bucket} />
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-5">
        <Stat label="Exchange inflow" tone="in" value={fmtDeod(t.inflow)} sub="DEOD into monitored addresses" title={`${t.inflow} DEOD`}
          trend={<Sparkline data={chart.map((x) => x.a)} color={SERIES.in} />} />
        <Stat label="Exchange outflow" tone="out" value={fmtDeod(t.outflow)} sub="DEOD out of monitored addresses" title={`${t.outflow} DEOD`}
          trend={<Sparkline data={chart.map((x) => x.b)} color={SERIES.out} />} />
        <Stat label="Unique wallets" value={fmtInt(t.uniqueWallets)} sub="Exchange counterparties + swap signers" />
        <Stat label="Exchange transfers" value={fmtInt(t.exchangeTransfers)} sub="DEOD transfers touching exchanges" />
        <Stat label="PancakeSwap volume" value={fmtDeod(ps.deod_volume)} sub={`${fmtUsd(ps.usd_volume, true)} · ${fmtInt(ps.swaps)} swaps`} title={`${ps.deod_volume} DEOD`} />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-5">
        <Card title="Exchange comparison (DEOD)" className="xl:col-span-2">
          <FlowBars rows={ov.exchanges} />
          <div className="border-t border-line p-3"><Note>{m.coverageNote}</Note></div>
        </Card>
        <Card title={`Exchange flow over time · per ${bucket}`} className="xl:col-span-3">
          <div className="px-2 pt-3"><PairBars data={chart} bucket={bucket} names={['IN', 'OUT', 'Net']} height={430} /></div>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-5">
        <Card title="Recent exchange activity" className="xl:col-span-3"
          actions={<Link className="link" href={`/flows?range=${r.range}`}>View all →</Link>}>
          {recent.rows.length ? (
            <table className="data">
              <thead><tr><th>Time (UTC)</th><th>Exchange</th><th>Wallet</th><th>Direction</th><th className="r">Amount (DEOD)</th><th>Tx</th></tr></thead>
              <tbody>
                {recent.rows.map((f: any) => (
                  <tr key={`${f.tx_hash}-${f.evt_index}-${f.direction}`}>
                    <td className="num text-ink-2">{fmtTime(f.block_time)}</td>
                    <td className="font-medium">{m.exchanges.find((e) => e.slug === f.exchange)?.name ?? f.exchange}</td>
                    <td><Addr a={f.wallet_address} labels={labels} /></td>
                    <td><Dir d={f.direction} /></td>
                    <td className="r bar-cell" style={barStyle(f.amount, maxRecent, f.direction === 'IN' ? 's1' : 's2')}><Deod v={f.amount} /></td>
                    <td><Tx hash={f.tx_hash} explorer={m.chain.explorer_tx_url} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <Empty />}
        </Card>

        <Card title="PancakeSwap" className="xl:col-span-2" actions={<Link className="link" href={`/PancakeSwap?range=${r.range}`}>Details →</Link>}>
          <div className="p-5">
            <div className="flex items-end justify-between gap-4">
              <div>
                <div className="text-xs font-medium text-muted">Last trade price</div>
                <div className="num mt-1 text-3xl font-semibold tracking-tight">{fmtPrice(ps.last_price)}</div>
                <div className="mt-0.5 text-xs text-ink-2">USDT per DEOD · from the latest swap</div>
              </div>
              <div className="text-right">
                <div className="text-xs font-medium text-muted">Swaps</div>
                <div className="num mt-1 text-2xl font-semibold">{fmtInt(ps.swaps)}</div>
              </div>
            </div>
            <div className="mt-5">
              <SplitBar a={Number(ps.buy_deod)} b={Number(ps.sell_deod)} names={['Buy volume', 'Sell volume']} format={money} />
            </div>
            <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 border-t border-line pt-4 text-sm">
              <div><dt className="text-xs text-muted">Buy · USD</dt><dd className="num">{fmtUsd(ps.buy_usd, true)} · {fmtInt(ps.buys)} buys</dd></div>
              <div><dt className="text-xs text-muted">Sell · USD</dt><dd className="num">{fmtUsd(ps.sell_usd, true)} · {fmtInt(ps.sells)} sells</dd></div>
              <div><dt className="text-xs text-muted">Unique traders</dt><dd className="num">{fmtInt(ps.unique_wallets)}</dd></div>
              <div><dt className="text-xs text-muted">Largest swap</dt><dd className="num">{fmtDeod(ps.largest_swap_deod)} DEOD</dd></div>
            </dl>
          </div>
          <div className="px-4 pb-4"><Note>{m.traderNote}</Note></div>
        </Card>
      </div>
    </>
  );
}
