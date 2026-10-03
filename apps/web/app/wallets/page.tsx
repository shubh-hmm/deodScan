import Link from 'next/link';
import { api, clean, flat, labelMap, meta, type SearchParams } from '@/lib/api';
import { fmtInt, fmtTime } from '@/lib/format';
import { Addr, Card, Deod, Empty, Note, PageHeader } from '@/components/ui';
import { Field, FilterForm, Select } from '@/components/filters';
import { RangePicker, rangeParams, windowLabel } from '@/components/range';

export const dynamic = 'force-dynamic';

const SORTS: [string, string][] = [
  ['volume', 'Total DEOD volume'], ['transactions', 'Transaction count'], ['largest', 'Largest single transfer/swap'],
  ['sent_to_exchanges', 'DEOD sent to exchanges'], ['received_from_exchanges', 'DEOD received from exchanges'],
  ['buy', 'PancakeSwap buy volume'], ['sell', 'PancakeSwap sell volume'],
];

export default async function Wallets({ searchParams }: { searchParams: SearchParams }) {
  const p = await flat(searchParams);
  const r = rangeParams({ range: 'all', ...p });
  const q = { source: p.source ?? 'all', sort: p.sort ?? 'volume', minVolume: p.minVolume, minTx: p.minTx, limit: p.limit ?? '100' };
  const [m, d] = await Promise.all([meta(), api('/api/wallets/top', { ...r, ...q })]);
  const labels = labelMap(m);
  const sources: [string, string][] = [
    ['all', 'All monitored activity'], ...m.exchanges.map((e) => [e.slug, e.name] as [string, string]),
    ['pancakeswap', 'PancakeSwap (V2 + V3)'], ['pancakeswap_v2', 'PancakeSwap V2'], ['pancakeswap_v3', 'PancakeSwap V3'],
  ];

  return (
    <>
      <PageHeader title="Top wallets" subtitle={`${windowLabel(d.window)} · ranked by ${SORTS.find(([k]) => k === q.sort)?.[1].toLowerCase()}`}>
        <RangePicker path="/wallets" params={{ range: r.range, ...p }} />
      </PageHeader>
      <Card title={`${d.rows.length} wallets`}
        actions={<a className="link" href={`/api-export/wallets/top?${new URLSearchParams(clean({ ...r, ...q }))}`}>Export CSV</a>}>
        <FilterForm action="/wallets" params={{ range: r.range, from: r.from, to: r.to }}>
          <Field label="Activity"><Select name="source" value={q.source} options={sources} /></Field>
          <Field label="Rank by"><Select name="sort" value={q.sort} options={SORTS} /></Field>
          <Field label="Min DEOD volume"><input name="minVolume" type="number" min="0" step="any" defaultValue={p.minVolume} className="w-32" /></Field>
          <Field label="Min transactions"><input name="minTx" type="number" min="0" defaultValue={p.minTx} className="w-24" /></Field>
          <Field label="Show"><Select name="limit" value={q.limit} options={[['25', 'Top 25'], ['100', 'Top 100'], ['500', 'Top 500'], ['1000', 'Top 1,000']]} /></Field>
        </FilterForm>
        {d.rows.length ? (
          <div className="overflow-x-auto">
            <table className="data">
              <thead><tr>
                <th>#</th><th>Wallet</th><th className="r">Volume (DEOD)</th><th className="r">Transactions</th><th className="r">Largest</th>
                <th className="r">Sent to exchanges</th><th className="r">Received from exchanges</th><th className="r">PCS bought</th><th className="r">PCS sold</th>
                <th>First seen</th><th>Last seen</th>
              </tr></thead>
              <tbody>
                {d.rows.map((w: any, i: number) => (
                  <tr key={w.wallet_address}>
                    <td className="text-muted">{i + 1}</td>
                    <td><Addr a={w.wallet_address} labels={labels} /></td>
                    <td className="r"><Deod v={w.volume} /></td>
                    <td className="r num">{fmtInt(w.transactions)}</td>
                    <td className="r"><Deod v={w.largest} /></td>
                    <td className="r"><Deod v={w.sent_to_exchanges} /></td>
                    <td className="r"><Deod v={w.received_from_exchanges} /></td>
                    <td className="r"><Deod v={w.swap_buy} /></td>
                    <td className="r"><Deod v={w.swap_sell} /></td>
                    <td className="num text-ink-2">{fmtTime(w.first_seen)}</td>
                    <td className="num text-ink-2">{fmtTime(w.last_seen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty>No wallets match these filters.</Empty>}
      </Card>
      <div className="mt-3 space-y-2">
        <Note>Volume counts DEOD moved in monitored activity only: transfers with the configured exchange addresses, plus PancakeSwap swaps (attributed to the transaction signer). Wallets are identified by address only; no behavioural labels are inferred.</Note>
        <Note>{m.coverageNote} <Link className="link" href="/status">Sync status</Link></Note>
      </div>
    </>
  );
}
