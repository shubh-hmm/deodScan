import Link from 'next/link';
import { api, clean, flat, labelMap, meta, type SearchParams } from '@/lib/api';
import { fmtDeod, fmtInt, fmtTime } from '@/lib/format';
import { pairSeries } from '@/lib/series';
import { Addr, barStyle, Card, Deod, Dir, Empty, Note, PageHeader, Stat, Tx } from '@/components/ui';
import { PairBars } from '@/components/charts';
import { RangePicker, rangeParams, windowLabel } from '@/components/range';

function TopTable({ rows, labels, kind }: { rows: any[]; labels: Map<string, string>; kind: 'Sender' | 'Receiver' }) {
  if (!rows.length) return <Empty />;
  const max = Math.max(0, ...rows.map((w) => Number(w.total)));
  const tone = kind === 'Sender' ? 's1' : 's2';
  return (
    <div className="overflow-x-auto">
      <table className="data">
        <thead><tr><th>#</th><th>{kind}</th><th className="r">Total DEOD</th><th className="r">Transfers</th><th className="r">Largest</th><th>First seen</th><th>Last seen</th></tr></thead>
        <tbody>
          {rows.map((w, i) => (
            <tr key={w.wallet_address}>
              <td className="text-muted">{i + 1}</td>
              <td><Addr a={w.wallet_address} labels={labels} /></td>
              <td className="r bar-cell" style={barStyle(w.total, max, tone)}><Deod v={w.total} /></td>
              <td className="r num">{fmtInt(w.transfers)}</td>
              <td className="r"><Deod v={w.largest} /></td>
              <td className="num text-ink-2">{fmtTime(w.first_seen)}</td>
              <td className="num text-ink-2">{fmtTime(w.last_seen)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function ExchangePage({ slug, searchParams }: { slug: string; searchParams: SearchParams }) {
  const p = await flat(searchParams);
  const r = rangeParams(p);
  const [m, d, recent] = await Promise.all([
    meta(),
    api(`/api/exchanges/${slug}`, r),
    api('/api/flows', { ...r, exchange: slug, limit: '25' }),
  ]);
  const labels = labelMap(m);
  const s = d.stats;
  const addrs = m.exchangeAddresses.filter((a) => a.exchange === slug && a.monitored);
  const chart = pairSeries(d.series, d.window, (x: any) => Number(x.inflow), (x: any) => Number(x.outflow));
  const maxRecent = Math.max(0, ...recent.rows.map((f: any) => Number(f.amount)));
  const daily = [...chart].reverse().filter((x) => x.a || x.b);
  const path = `/${d.exchange.name}`;

  return (
    <>
      <PageHeader eyebrow="Exchange" title={d.exchange.name} subtitle={`${windowLabel(d.window)} · DEOD flows through monitored ${d.exchange.name} address${addrs.length > 1 ? 'es' : ''}`}>
        <RangePicker path={path} params={p} />
      </PageHeader>

      <div className="mb-4 space-y-2">
        {addrs.map((a) => (
          <Note key={a.address}>
            Monitored address <span className="font-mono">{a.address}</span> · type: {a.address_type.replace('_', ' ')}
            {a.dune_label && <> · Dune label: “{a.dune_label}”</>}
            {' · '}{a.verified ? 'verified by admin' : 'not admin-verified'}
            {a.notes && <> · {a.notes}</>}
          </Note>
        ))}
        <Note>{m.coverageNote}</Note>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Inflow (deposits)" tone="in" value={fmtDeod(s.inflow)} sub={`${fmtInt(s.deposits)} transfers · ${fmtInt(s.unique_depositors)} senders`} title={`${s.inflow} DEOD`} />
        <Stat label="Outflow (withdrawals)" tone="out" value={fmtDeod(s.outflow)} sub={`${fmtInt(s.withdrawals)} transfers · ${fmtInt(s.unique_withdrawers)} receivers`} title={`${s.outflow} DEOD`} />
        <Stat label="Net flow" value={fmtDeod(s.net, { sign: true })} sub="Inflow − outflow" title={`${s.net} DEOD`} />
        <Stat label="Unique wallets" value={fmtInt(s.unique_wallets)} sub={`Largest in ${fmtDeod(s.largest_deposit)} · out ${fmtDeod(s.largest_withdrawal)}`} />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-5">
        <Card title={`Historical flow · per ${d.window.bucket}`} className="xl:col-span-3">
          <div className="px-2 pt-2"><PairBars data={chart} bucket={d.window.bucket} names={['IN', 'OUT', 'Net']} height={300} /></div>
        </Card>
        <Card title={`${d.window.bucket === 'hour' ? 'Hourly' : 'Daily'} flow table (DEOD)`} className="xl:col-span-2">
          {daily.length ? (
            <div className="max-h-[290px] overflow-y-auto">
              <table className="data">
                <thead><tr><th>{d.window.bucket === 'hour' ? 'Hour (UTC)' : 'Date (UTC)'}</th><th className="r">IN</th><th className="r">OUT</th><th className="r">Net</th></tr></thead>
                <tbody>
                  {daily.map((x) => (
                    <tr key={x.bucket}>
                      <td className="num text-ink-2">{d.window.bucket === 'hour' ? fmtTime(x.bucket) : x.bucket.slice(0, 10)}</td>
                      <td className="r num">{fmtDeod(x.a)}</td>
                      <td className="r num">{fmtDeod(x.b)}</td>
                      <td className="r num">{fmtDeod(x.a - x.b, { sign: true })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <Empty />}
        </Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card title={`Top wallets sending DEOD to ${d.exchange.name}`}
          actions={<Link className="link" href={`/api-export/wallets/top?${new URLSearchParams({ ...clean(r), source: slug, sort: 'sent_to_exchanges', limit: '1000' })}`}>CSV</Link>}>
          <TopTable rows={d.topDepositors} labels={labels} kind="Sender" />
        </Card>
        <Card title={`Top wallets receiving DEOD from ${d.exchange.name}`}
          actions={<Link className="link" href={`/api-export/wallets/top?${new URLSearchParams({ ...clean(r), source: slug, sort: 'received_from_exchanges', limit: '1000' })}`}>CSV</Link>}>
          <TopTable rows={d.topWithdrawers} labels={labels} kind="Receiver" />
        </Card>
      </div>

      <Card title="Recent transfers" className="mt-4"
        actions={<>
          <Link className="link" href={`/flows?exchange=${slug}&range=${r.range}`}>Filter & browse →</Link>
          <Link className="link" href={`/api-export/flows?${new URLSearchParams({ ...clean(r), exchange: slug })}`}>CSV</Link>
        </>}>
        {recent.rows.length ? (
          <div className="overflow-x-auto">
            <table className="data">
              <thead><tr><th>Time (UTC)</th><th>Direction</th><th>From</th><th>To</th><th className="r">Amount (DEOD)</th><th className="r">Block</th><th>Tx</th></tr></thead>
              <tbody>
                {recent.rows.map((f: any) => (
                  <tr key={`${f.tx_hash}-${f.evt_index}-${f.direction}`}>
                    <td className="num text-ink-2">{fmtTime(f.block_time, true)}</td>
                    <td><Dir d={f.direction} /></td>
                    <td><Addr a={f.direction === 'IN' ? f.wallet_address : f.exchange_address} labels={labels} /></td>
                    <td><Addr a={f.direction === 'IN' ? f.exchange_address : f.wallet_address} labels={labels} /></td>
                    <td className="r bar-cell" style={barStyle(f.amount, maxRecent, f.direction === 'IN' ? 's1' : 's2')}><Deod v={f.amount} /></td>
                    <td className="r num text-ink-2">{f.block_number}</td>
                    <td><Tx hash={f.tx_hash} explorer={m.chain.explorer_tx_url} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty />}
      </Card>
    </>
  );
}
