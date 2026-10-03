import Link from 'next/link';
import { api, flat, labelMap, meta, type SearchParams } from '@/lib/api';
import { fmtDeod, fmtInt, fmtPrice, fmtTime, fmtUsd } from '@/lib/format';
import { pairSeries } from '@/lib/series';
import { Addr, Card, Deod, Dir, Note, PageHeader, Stat, Tx, Empty } from '@/components/ui';
import { PairBars } from '@/components/charts';
import { RangePicker, rangeParams, windowLabel } from '@/components/range';

export const dynamic = 'force-dynamic';

export default async function Dashboard({ searchParams }: { searchParams: SearchParams }) {
  const p = await flat(searchParams);
  const r = rangeParams(p);
  const [m, ov, series, recent] = await Promise.all([
    meta(),
    api('/api/overview', r),
    api('/api/flows/series', r),
    api('/api/flows', { ...r, limit: '15' }),
  ]);
  const labels = labelMap(m);
  const t = ov.totals;
  const ps = ov.pancakeswap;
  const chart = pairSeries(series.rows, series.window, (x: any) => Number(x.inflow), (x: any) => Number(x.outflow));

  return (
    <>
      <PageHeader title="DEOD On-Chain Monitor"
        subtitle={`${windowLabel(ov.window)} · BNB Chain · Data through ${m.dataThrough ? `${fmtTime(m.dataThrough)} UTC` : 'n/a'}`}>
        <RangePicker path="/" params={p} />
      </PageHeader>
      <div className="mb-3"><Note>{m.freshnessNote}</Note></div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        <Stat label="Exchange inflow" tone="in" value={fmtDeod(t.inflow)} sub="DEOD into monitored exchange addresses" title={`${t.inflow} DEOD`} />
        <Stat label="Exchange outflow" tone="out" value={fmtDeod(t.outflow)} sub="DEOD out of monitored exchange addresses" title={`${t.outflow} DEOD`} />
        <Stat label="Net exchange flow" value={fmtDeod(t.net, { sign: true })} sub="Inflow − outflow" title={`${t.net} DEOD`} />
        <Stat label="Unique wallets" value={fmtInt(t.uniqueWallets)} sub="Exchange counterparties + swap signers" />
        <Stat label="Exchange transfers" value={fmtInt(t.exchangeTransfers)} sub="DEOD transfers touching exchanges" />
        <Stat label="PancakeSwap volume" value={fmtDeod(ps.deod_volume)} sub={`${fmtUsd(ps.usd_volume, true)} · ${fmtInt(ps.swaps)} swaps`} title={`${ps.deod_volume} DEOD`} />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-5">
        <Card title="Exchange flow by exchange (DEOD)" className="xl:col-span-2">
          <table className="data">
            <thead><tr><th>Exchange</th><th className="r">IN</th><th className="r">OUT</th><th className="r">Net</th><th className="r">Deposits</th><th className="r">Withdrawals</th></tr></thead>
            <tbody>
              {ov.exchanges.map((e: any) => (
                <tr key={e.exchange}>
                  <td><Link className="link" href={`/${e.name}`}>{e.name}</Link></td>
                  <td className="r"><Deod v={e.inflow} /></td>
                  <td className="r"><Deod v={e.outflow} /></td>
                  <td className="r"><Deod v={e.net} sign /></td>
                  <td className="r num">{fmtInt(e.deposits)}</td>
                  <td className="r num">{fmtInt(e.withdrawals)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="p-3"><Note>{m.coverageNote}</Note></div>
        </Card>

        <Card title={`Exchange flow over time · per ${series.window.bucket}`} className="xl:col-span-3">
          <div className="px-2 pt-2"><PairBars data={chart} bucket={series.window.bucket} names={['IN', 'OUT', 'Net']} /></div>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-5">
        <Card title="Recent exchange activity" className="xl:col-span-3"
          actions={<Link className="link" href={`/flows?range=${r.range}`}>View all →</Link>}>
          {recent.rows.length ? (
            <div className="overflow-x-auto">
              <table className="data">
                <thead><tr><th>Time (UTC)</th><th>Exchange</th><th>Wallet</th><th>Direction</th><th className="r">Amount (DEOD)</th><th>Tx</th></tr></thead>
                <tbody>
                  {recent.rows.map((f: any) => (
                    <tr key={`${f.tx_hash}-${f.evt_index}-${f.direction}`}>
                      <td className="num text-ink-2">{fmtTime(f.block_time)}</td>
                      <td>{m.exchanges.find((e) => e.slug === f.exchange)?.name ?? f.exchange}</td>
                      <td><Addr a={f.wallet_address} labels={labels} /></td>
                      <td><Dir d={f.direction} /></td>
                      <td className="r"><Deod v={f.amount} /></td>
                      <td><Tx hash={f.tx_hash} explorer={m.chain.explorer_tx_url} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <Empty />}
        </Card>

        <Card title="PancakeSwap" className="xl:col-span-2" actions={<Link className="link" href={`/PancakeSwap?range=${r.range}`}>Details →</Link>}>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 p-4 text-sm">
            <div><dt className="text-xs text-muted">Last price</dt><dd className="num">{fmtPrice(ps.last_price)} <span className="text-xs text-muted">USDT/DEOD</span></dd></div>
            <div><dt className="text-xs text-muted">Swaps</dt><dd className="num">{fmtInt(ps.swaps)}</dd></div>
            <div><dt className="text-xs text-muted">Buy volume</dt><dd className="num">{fmtDeod(ps.buy_deod)} DEOD · {fmtUsd(ps.buy_usd, true)}</dd></div>
            <div><dt className="text-xs text-muted">Sell volume</dt><dd className="num">{fmtDeod(ps.sell_deod)} DEOD · {fmtUsd(ps.sell_usd, true)}</dd></div>
            <div><dt className="text-xs text-muted">Unique traders</dt><dd className="num">{fmtInt(ps.unique_wallets)}</dd></div>
            <div><dt className="text-xs text-muted">Largest swap</dt><dd className="num">{fmtDeod(ps.largest_swap_deod)} DEOD</dd></div>
          </dl>
          <div className="px-3 pb-3"><Note>{m.traderNote}</Note></div>
        </Card>
      </div>
    </>
  );
}
