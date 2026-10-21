import Link from 'next/link';
import { api, clean, flat, labelMap, meta, type SearchParams } from '@/lib/api';
import { fmtDeod, fmtInt, fmtPrice, fmtTime, fmtUsd } from '@/lib/format';
import { pairSeries, withCumulative } from '@/lib/series';
import { Addr, barStyle, Card, Deod, Dir, Empty, Note, PageHeader, SplitBar, Stat, Tx } from '@/components/ui';
import { CumulativeArea, Donut, FlowArea, HourBars, Sparkline } from '@/components/charts';
import { RAMPS, SERIES } from '@/lib/colors';
import { ExchangeCards } from '@/components/flow-bars';
import { ExportMenu } from '@/components/export-menu';
import { Icons } from '@/components/icons';
import { RangePicker, rangeParams, windowLabel } from '@/components/range';

export const dynamic = 'force-dynamic';

/** Change against the previous period of the same length, as plain text: arrow and sign carry the direction, never colour. */
function delta(cur: number, prev: number | null): string | undefined {
  if (prev === null) return undefined;
  if (prev === 0) return cur === 0 ? 'No change vs previous period' : 'No activity in previous period';
  const pct = ((cur - prev) / prev) * 100;
  return `${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct).toFixed(1)}% vs previous period`;
}

/** Donut + value list for one direction's share by exchange. Blue steps for inflow, orange steps for outflow. */
function ShareCard({ title, rows, kind }: { title: string; rows: { name: string; value: number }[]; kind: 'in' | 'out' }) {
  const sorted = [...rows].sort((a, b) => b.value - a.value);
  const total = sorted.reduce((a, x) => a + x.value, 0);
  const slices = sorted.map((x, i) => ({ ...x, color: RAMPS[kind][i % RAMPS[kind].length]! }));
  return (
    <Card title={title}>
      <div className="p-4">
        <Donut slices={slices} centerLabel={kind === 'in' ? 'Inflow' : 'Outflow'} centerValue={fmtDeod(total)} />
        <ul className="mt-3 space-y-2 text-sm">
          {slices.map((s) => (
            <li key={s.name} className="flex items-center gap-2.5">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: s.color }} />
              <span className="min-w-0 flex-1 truncate text-ink-2">{s.name}</span>
              <span className="num font-medium text-ink">{fmtDeod(s.value)}</span>
              <span className="num w-12 text-right text-xs text-muted">{total > 0 ? `${((s.value / total) * 100).toFixed(1)}%` : '—'}</span>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

export default async function Dashboard({ searchParams }: { searchParams: SearchParams }) {
  const p = await flat(searchParams);
  const r = rangeParams(p);
  const [m, ov, series, recent, hourly, top] = await Promise.all([
    meta(),
    api('/api/overview', r),
    api('/api/flows/series', r),
    api('/api/flows', { ...r, limit: '10' }),
    api('/api/flows/hourly', r),
    api('/api/wallets/top', { ...r, limit: '8', sort: 'volume' }),
  ]);

  // Previous period of the same length, for the change shown on each KPI card ("all time" has no previous period).
  let prev: any = null;
  if (ov.window.from) {
    const from = new Date(ov.window.from);
    const prevFrom = new Date(from.getTime() - (new Date(ov.window.to).getTime() - from.getTime()));
    prev = await api('/api/overview', { range: 'custom', from: prevFrom.toISOString(), to: from.toISOString() }).catch(() => null);
  }
  const pv = (get: (o: any) => number) => (prev ? get(prev) : null);

  const labels = labelMap(m);
  const t = ov.totals;
  const ps = ov.pancakeswap;
  const chart = pairSeries(series.rows, series.window, (x: any) => Number(x.inflow), (x: any) => Number(x.outflow));
  const cum = withCumulative(chart);
  const bucket = series.window.bucket as 'hour' | 'day';
  const maxRecent = Math.max(0, ...recent.rows.map((f: any) => Number(f.amount)));
  const maxTop = Math.max(0, ...top.rows.map((w: any) => Number(w.volume)));
  const money = (v: number) => `${fmtDeod(v)} DEOD`;
  const q = new URLSearchParams(clean(r));
  const exports = [
    { href: `/api-export/activity?${q}`, title: 'All activity', hint: 'Exchange transfers and PancakeSwap swaps together, newest first' },
    { href: `/api-export/flows?${q}`, title: 'Exchange flows only', hint: 'MEXC, Toobit, XT and BingX deposits and withdrawals' },
    { href: `/api-export/swaps?${q}`, title: 'PancakeSwap swaps only', hint: 'V2 and V3 buys and sells' },
  ];

  return (
    <>
      <PageHeader eyebrow="DEODScan" title="Overview"
        subtitle={`${windowLabel(ov.window)} · BNB Chain · Data through ${m.dataThrough ? `${fmtTime(m.dataThrough)} UTC` : 'n/a'}`}>
        <RangePicker path="/" params={p} />
      </PageHeader>

      <div className="mb-4"><Note>{m.freshnessNote}</Note></div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        <Stat icon={Icons.exchange} label="Net exchange flow" value={fmtDeod(t.net, { sign: true })} title={`${t.net} DEOD`}
          sub="Inflow − outflow" delta={prev ? `Previous period: ${fmtDeod(prev.totals.net, { sign: true })}` : undefined} />
        <Stat icon={Icons.down} label="Exchange inflow" tone="in" value={fmtDeod(t.inflow)} title={`${t.inflow} DEOD`}
          delta={delta(Number(t.inflow), pv((o) => Number(o.totals.inflow)))}
          trend={<Sparkline data={chart.map((x) => x.a)} color={SERIES.in} />} />
        <Stat icon={Icons.up} label="Exchange outflow" tone="out" value={fmtDeod(t.outflow)} title={`${t.outflow} DEOD`}
          delta={delta(Number(t.outflow), pv((o) => Number(o.totals.outflow)))}
          trend={<Sparkline data={chart.map((x) => x.b)} color={SERIES.out} />} />
        <Stat icon={Icons.wallets} label="Unique wallets" value={fmtInt(t.uniqueWallets)}
          delta={delta(t.uniqueWallets, pv((o) => o.totals.uniqueWallets))} />
        <Stat icon={Icons.activity} label="Exchange transfers" value={fmtInt(t.exchangeTransfers)}
          delta={delta(t.exchangeTransfers, pv((o) => o.totals.exchangeTransfers))} />
        <Stat icon={Icons.layers} label="PancakeSwap volume" value={fmtDeod(ps.deod_volume)} title={`${ps.deod_volume} DEOD`}
          sub={`${fmtUsd(ps.usd_volume, true)} · ${fmtInt(ps.swaps)} swaps`}
          delta={delta(Number(ps.deod_volume), pv((o) => Number(o.pancakeswap.deod_volume)))} />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2" title={`Exchange flow (${bucket === 'hour' ? 'hourly' : 'daily'} graph)`}
          actions={<ExportMenu items={exports} />}>
          <div className="flex flex-wrap gap-2 px-4 pt-4">
            <span className="chip"><span className="h-2 w-2 rounded-full bg-s1" />Total inflow<b className="num font-semibold text-ink">{fmtDeod(t.inflow)}</b></span>
            <span className="chip"><span className="h-2 w-2 rounded-full bg-s2" />Total outflow<b className="num font-semibold text-ink">{fmtDeod(t.outflow)}</b></span>
            <span className="chip text-muted">per {bucket} · UTC</span>
          </div>
          <div className="px-2 pt-2"><FlowArea data={chart} bucket={bucket} names={['IN', 'OUT', 'Net']} height={320} /></div>
        </Card>
        <Card title="Cumulative net flow" actions={<span className="text-xs text-muted">running total, per {bucket}</span>}>
          <div className="px-2 pt-4"><CumulativeArea data={cum} bucket={bucket} height={352} /></div>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-4">
        <ShareCard title="Inflow by exchange" kind="in" rows={ov.exchanges.map((e: any) => ({ name: e.name, value: Number(e.inflow) }))} />
        <Card className="xl:col-span-2" title="Exchange transfers by hour of day (UTC)">
          <div className="flex flex-wrap gap-2 px-4 pt-4">
            <span className="chip"><span className="h-2 w-2 rounded-full bg-s1" />IN transfers</span>
            <span className="chip"><span className="h-2 w-2 rounded-full bg-s2" />OUT transfers</span>
            <span className="chip text-muted">{windowLabel(ov.window)}</span>
          </div>
          <div className="px-2 pt-2"><HourBars data={hourly.rows} height={250} /></div>
        </Card>
        <ShareCard title="Outflow by exchange" kind="out" rows={ov.exchanges.map((e: any) => ({ name: e.name, value: Number(e.outflow) }))} />
      </div>

      <div className="mt-4"><ExchangeCards rows={ov.exchanges} /></div>
      <div className="mt-3"><Note>{m.coverageNote}</Note></div>

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

        <Card title="Top wallets" className="xl:col-span-2" actions={<Link className="link" href={`/wallets?range=${r.range}`}>View all →</Link>}>
          {top.rows.length ? (
            <table className="data">
              <thead><tr><th>#</th><th>Wallet</th><th className="r">Volume (DEOD)</th><th className="r">Txs</th></tr></thead>
              <tbody>
                {top.rows.map((w: any, i: number) => (
                  <tr key={w.wallet_address}>
                    <td className="text-muted">{i + 1}</td>
                    <td><Addr a={w.wallet_address} labels={labels} /></td>
                    <td className="r bar-cell" style={barStyle(w.volume, maxTop)}><Deod v={w.volume} /></td>
                    <td className="r num">{fmtInt(w.transactions)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <Empty />}
        </Card>
      </div>

      <Card title="PancakeSwap" className="mt-4" actions={<Link className="link" href={`/PancakeSwap?range=${r.range}`}>Details →</Link>}>
        <div className="grid gap-6 p-5 xl:grid-cols-3">
          <div>
            <div className="text-xs font-medium text-muted">Last trade price</div>
            <div className="num mt-1 text-3xl font-semibold tracking-tight">{fmtPrice(ps.last_price)}</div>
            <div className="mt-0.5 text-xs text-ink-2">USDT per DEOD · from the latest swap · {fmtInt(ps.swaps)} swaps</div>
          </div>
          <div className="xl:col-span-2">
            <SplitBar a={Number(ps.buy_deod)} b={Number(ps.sell_deod)} names={['Buy volume', 'Sell volume']} format={money} />
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm xl:col-span-3 xl:grid-cols-4">
            <div><dt className="text-xs text-muted">Buy · USD</dt><dd className="num">{fmtUsd(ps.buy_usd, true)} · {fmtInt(ps.buys)} buys</dd></div>
            <div><dt className="text-xs text-muted">Sell · USD</dt><dd className="num">{fmtUsd(ps.sell_usd, true)} · {fmtInt(ps.sells)} sells</dd></div>
            <div><dt className="text-xs text-muted">Unique traders</dt><dd className="num">{fmtInt(ps.unique_wallets)}</dd></div>
            <div><dt className="text-xs text-muted">Largest swap</dt><dd className="num">{fmtDeod(ps.largest_swap_deod)} DEOD</dd></div>
          </dl>
        </div>
        <div className="px-4 pb-4"><Note>{m.traderNote}</Note></div>
      </Card>
    </>
  );
}
