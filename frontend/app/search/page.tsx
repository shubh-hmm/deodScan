import { redirect } from 'next/navigation';
import { api, flat, labelMap, meta, type SearchParams } from '@/lib/api';
import { fmtTime, venueName } from '@/lib/format';
import { Addr, Card, Deod, Dir, Empty, PageHeader, Tx } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function Search({ searchParams }: { searchParams: SearchParams }) {
  const { q = '' } = await flat(searchParams);
  const query = q.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(query)) redirect(`/wallet/${query.toLowerCase()}`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(query)) {
    return (
      <>
        <PageHeader title="Search" />
        <Card><Empty>Enter a 42-character wallet address or a 66-character transaction hash (0x…).</Empty></Card>
      </>
    );
  }
  const [m, r] = await Promise.all([meta(), api('/api/search', { q: query })]);
  const labels = labelMap(m);
  return (
    <>
      <PageHeader title="Transaction" subtitle={<span className="font-mono">{query.toLowerCase()}</span>} />
      <Card title={`${r.results.length} monitored event${r.results.length === 1 ? '' : 's'} in this transaction`}
        actions={<a className="link" href={`${m.chain.explorer_tx_url}${query.toLowerCase()}`} target="_blank" rel="noreferrer">View on BscScan</a>}>
        {r.results.length ? (
          <table className="data">
            <thead><tr><th>Time (UTC)</th><th>Venue</th><th>Action</th><th>Wallet</th><th className="r">DEOD</th><th>Tx</th></tr></thead>
            <tbody>
              {r.results.map((x: any, i: number) => (
                <tr key={i}>
                  <td className="num text-ink-2">{fmtTime(x.block_time, true)}</td>
                  <td>{venueName(x.venue)}</td>
                  <td><Dir d={x.action} /></td>
                  <td><Addr a={x.wallet_address} labels={labels} /></td>
                  <td className="r"><Deod v={x.amount} /></td>
                  <td><Tx hash={x.tx_hash} explorer={m.chain.explorer_tx_url} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <Empty>This transaction has no monitored DEOD exchange transfer or PancakeSwap swap.</Empty>}
      </Card>
    </>
  );
}
