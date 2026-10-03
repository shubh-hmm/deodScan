import { notFound } from 'next/navigation';
import { api, flat, labelMap, meta, type SearchParams } from '@/lib/api';
import { fmtDeod, fmtInt, fmtTime, fmtUsd, venueName } from '@/lib/format';
import { Card, Deod, Dir, Empty, Note, PageHeader, Stat, Tx } from '@/components/ui';
import { Pager } from '@/components/filters';

export const dynamic = 'force-dynamic';
const LIMIT = 200;

export default async function Wallet({ params, searchParams }: { params: Promise<{ address: string }>; searchParams: SearchParams }) {
  const { address: raw } = await params;
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) notFound();
  const address = raw.toLowerCase();
  const p = await flat(searchParams);
  const [m, d] = await Promise.all([meta(), api(`/api/wallets/${address}`, { limit: String(LIMIT), offset: p.offset })]);
  const labels = labelMap(m);
  const s = d.summary;
  const label = labels.get(address);

  const exRow = (slug: string, dir: string) => d.exchanges.find((x: any) => x.exchange === slug && x.direction === dir);
  const swRow = (v: string, side: string) => d.swaps.find((x: any) => x.version === v && x.side === side);

  return (
    <>
      <PageHeader
        title={<span className="font-mono text-lg">{address}</span>}
        subtitle={<>
          {label ? <span className="mr-2 rounded bg-surface-2 px-1.5 py-0.5 text-xs">{label}</span> : <span className="mr-2 text-xs text-muted">No configured label</span>}
          <a className="link" href={`${m.chain.explorer_address_url}${address}`} target="_blank" rel="noreferrer">View on BscScan</a>
          {' · '}<a className="link" href={`/api-export/wallets/${address}/activity.csv`}>Export activity CSV</a>
        </>}
      />

      {!s ? (
        <Card><Empty>No monitored DEOD activity for this address (no transfers with configured exchange addresses and no PancakeSwap swaps as transaction signer).
          {d.swapsAsRecipientOnly > 0 && ` It was the swap recipient in ${d.swapsAsRecipientOnly} swaps signed by other addresses.`}</Empty></Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-6">
            <Stat label="Total DEOD volume" value={fmtDeod(s.total_deod_volume)} title={`${s.total_deod_volume} DEOD`} sub="Monitored activity" />
            <Stat label="Transactions" value={fmtInt(s.transaction_count)} />
            <Stat label="Sent to exchanges" tone="in" value={fmtDeod(s.sent_to_exchanges)} sub={`${fmtInt(d.exchanges.filter((x: any) => x.direction === 'IN').reduce((a: number, x: any) => a + Number(x.transfers), 0))} transfers`} />
            <Stat label="Received from exchanges" tone="out" value={fmtDeod(s.received_from_exchanges)} sub={`${fmtInt(d.exchanges.filter((x: any) => x.direction === 'OUT').reduce((a: number, x: any) => a + Number(x.transfers), 0))} transfers`} />
            <Stat label="First seen" value={<span className="text-base">{fmtTime(s.first_seen)}</span>} sub="UTC" />
            <Stat label="Last seen" value={<span className="text-base">{fmtTime(s.last_seen)}</span>} sub="UTC" />
          </div>

          <div className="mt-4 grid gap-4 xl:grid-cols-2">
            <Card title="Exchange activity (DEOD)">
              <table className="data">
                <thead><tr><th>Exchange</th><th className="r">Sent to (IN)</th><th className="r">Transfers</th><th className="r">Received from (OUT)</th><th className="r">Transfers</th><th className="r">Largest</th></tr></thead>
                <tbody>
                  {m.exchanges.map((e) => {
                    const i = exRow(e.slug, 'IN'); const o = exRow(e.slug, 'OUT');
                    const largest = Math.max(Number(i?.largest ?? 0), Number(o?.largest ?? 0));
                    return (
                      <tr key={e.slug}>
                        <td>{e.name}</td>
                        <td className="r"><Deod v={i?.total ?? '0'} /></td><td className="r num">{fmtInt(i?.transfers ?? 0)}</td>
                        <td className="r"><Deod v={o?.total ?? '0'} /></td><td className="r num">{fmtInt(o?.transfers ?? 0)}</td>
                        <td className="r num">{largest ? fmtDeod(largest) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Card>
            <Card title="PancakeSwap activity (as transaction signer)">
              <table className="data">
                <thead><tr><th>Pool</th><th className="r">Bought DEOD</th><th className="r">Buys</th><th className="r">Sold DEOD</th><th className="r">Sells</th><th className="r">USD volume</th></tr></thead>
                <tbody>
                  {['2', '3'].map((v) => {
                    const b = swRow(v, 'BUY'); const sl = swRow(v, 'SELL');
                    return (
                      <tr key={v}>
                        <td>V{v}</td>
                        <td className="r"><Deod v={b?.deod ?? '0'} /></td><td className="r num">{fmtInt(b?.swaps ?? 0)}</td>
                        <td className="r"><Deod v={sl?.deod ?? '0'} /></td><td className="r num">{fmtInt(sl?.swaps ?? 0)}</td>
                        <td className="r num">{fmtUsd(Number(b?.usd ?? 0) + Number(sl?.usd ?? 0), true)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="space-y-2 p-3">
                <Note>Largest exchange transfer: {fmtDeod(s.largest_transfer)} DEOD · Largest swap: {fmtDeod(s.largest_swap)} DEOD</Note>
                {d.swapsAsRecipientOnly > 0 && <Note>This address was also the swap recipient in {d.swapsAsRecipientOnly} swaps signed by other addresses (not counted above).</Note>}
              </div>
            </Card>
          </div>

          <Card title="Activity timeline" className="mt-4">
            {d.timeline.length ? (
              <div className="overflow-x-auto">
                <table className="data">
                  <thead><tr><th>Time (UTC)</th><th>Venue</th><th>Action</th><th className="r">DEOD</th><th className="r">USD</th><th>Counterparty</th><th className="r">Block</th><th>Tx</th></tr></thead>
                  <tbody>
                    {d.timeline.map((t: any) => (
                      <tr key={`${t.tx_hash}-${t.evt_index}-${t.action}`}>
                        <td className="num text-ink-2">{fmtTime(t.block_time, true)}</td>
                        <td>{venueName(t.venue)}</td>
                        <td>
                          <Dir d={t.action} />
                          <span className="ml-2 text-xs text-muted">
                            {t.kind === 'exchange' ? (t.action === 'IN' ? `→ ${venueName(t.venue)}` : `← ${venueName(t.venue)}`) : 'swap'}
                          </span>
                        </td>
                        <td className="r"><Deod v={t.deod_amount} /></td>
                        <td className="r num">{t.usd_value ? fmtUsd(t.usd_value) : '—'}</td>
                        <td className="text-xs text-ink-2">{labels.get(t.counterparty) ?? t.counterparty}</td>
                        <td className="r num text-ink-2">{t.block_number}</td>
                        <td><Tx hash={t.tx_hash} explorer={m.chain.explorer_tx_url} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <Empty />}
            <Pager path={`/wallet/${address}`} params={p} total={Number(s.exchange_transfer_count) + Number(s.swap_count)} limit={LIMIT} />
          </Card>
          <div className="mt-3"><Note>Exchange IN = this wallet sent DEOD to the exchange address; OUT = it received DEOD from it. Totals reflect monitored activity only; they are not the wallet&apos;s DEOD balance.</Note></div>
        </>
      )}
    </>
  );
}
